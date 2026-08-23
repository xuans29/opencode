import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { ToolOutput } from "@opencode-ai/core/tool-output"
import { FSUtil } from "@opencode-ai/util/fs-util"
import { Global } from "@opencode-ai/util/global"
import { Hash } from "@opencode-ai/util/hash"
import { Identifier } from "@opencode-ai/core/id/id"
import { Session } from "@opencode-ai/schema/session"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"

const sessionID = Session.ID.create()

const withStore = <A, E, R>(
  body: (output: ToolOutput.Interface, fs: FSUtil.Interface, root: string) => Effect.Effect<A, E, R>,
  limits?: {
    maxLines?: number
    maxBytes?: number
    maxArchiveBytes?: number
    maxArchiveFiles?: number
    maxArchiveTotalBytes?: number
    maxSessionArchiveFiles?: number
    maxSessionArchiveBytes?: number
  },
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => {
      const layer = AppNodeBuilder.build(LayerNode.group([ToolOutput.node, FSUtil.node]), [
        [
          Global.node,
          Global.layerWith({
            data: path.join(tmp.path, "data"),
            cache: path.join(tmp.path, "cache"),
            config: path.join(tmp.path, "config"),
            state: path.join(tmp.path, "state"),
            tmp: path.join(tmp.path, "tmp"),
            bin: path.join(tmp.path, "bin"),
            log: path.join(tmp.path, "log"),
            repos: path.join(tmp.path, "repos"),
          }),
        ],
      ])
      return Effect.gen(function* () {
        const output = yield* ToolOutput.Service
        if (limits) yield* output.transform((draft) => draft.configure(limits))
        return yield* body(output, yield* FSUtil.Service, path.join(tmp.path, "data"))
      }).pipe(Effect.provide(layer))
    },
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

describe("ToolOutput", () => {
  it.live("writes oversized text and returns a bounded preview", () =>
    withStore(
      (service, fs) =>
        Effect.gen(function* () {
          const output = { items: [1, 2, 3] }
          const result = yield* service.truncate(sessionID, { output, content: "one\ntwo\nthree" })
          expect(result.output).toBe(output)
          expect(result.metadata).toMatchObject({ truncated: true })
          const outputPath = result.metadata?.outputPath
          expect(typeof outputPath).toBe("string")
          if (typeof outputPath !== "string") return
          expect(yield* fs.readFileString(outputPath)).toBe("one\ntwo\nthree")
          expect(result.content).toEqual([
            { type: "text", text: "one\ntwo" },
            { type: "text", text: `... 1 line truncated; full content saved to ${outputPath} ...` },
          ])
        }),
      { maxLines: 2, maxBytes: 1_000 },
    ),
  )

  it.live("reports bytes omitted by the byte limit", () =>
    withStore(
      (output) =>
        Effect.gen(function* () {
          const result = yield* output.truncate(sessionID, { content: "one\ntwo" })
          expect(result.content).toEqual([
            { type: "text", text: "one" },
            {
              type: "text",
              text: expect.stringMatching(/^\.\.\. 4 bytes truncated; full content saved to .+ \.\.\.$/),
            },
          ])
        }),
      { maxLines: 100, maxBytes: 5 },
    ),
  )

  it.live("preserves mixed content ordering", () =>
    withStore(
      (output) =>
        Effect.gen(function* () {
          const file = { type: "file" as const, uri: "file:///image.png", mime: "image/png" }
          const result = yield* output.truncate(sessionID, {
            content: [{ type: "text", text: "before" }, file, { type: "text", text: "after\nomitted" }],
          })
          expect(result.content).toEqual([
            { type: "text", text: "before" },
            file,
            { type: "text", text: "after" },
            { type: "text", text: expect.stringMatching(/^\.\.\. 1 line truncated; full content saved to /) },
          ])
        }),
      { maxLines: 2, maxBytes: 1_000 },
    ),
  )

  it.live("preserves bounded results that report a truncation state", () =>
    withStore((output) =>
      Effect.gen(function* () {
        const truncated = { content: "one\ntwo", metadata: { truncated: true, source: "tool" } }
        const retained = { content: "one\ntwo", metadata: { truncated: false, source: "tool" } }
        expect(yield* output.truncate(sessionID, truncated)).toBe(truncated)
        expect(yield* output.truncate(sessionID, retained)).toBe(retained)
      }),
    ),
  )

  it.live("enforces limits on results that already report a truncation state", () =>
    withStore(
      (output, fs) =>
        Effect.gen(function* () {
          yield* Effect.forEach([false, true], (reported) =>
            Effect.gen(function* () {
              const original = {
                content: "one\ntwo\nthree",
                metadata: { truncated: reported, source: "tool" },
              }
              const result = yield* output.truncate(sessionID, original)
              expect(result).not.toBe(original)
              expect(result.metadata).toMatchObject({ truncated: true, source: "tool" })
              const outputPath = result.metadata?.outputPath
              expect(typeof outputPath).toBe("string")
              if (typeof outputPath !== "string") return
              expect(yield* fs.readFileString(outputPath)).toBe(original.content)
              expect(result.content).toEqual([
                { type: "text", text: "one\ntwo" },
                { type: "text", text: `... 1 line truncated; full content saved to ${outputPath} ...` },
              ])
            }),
          )
        }),
      { maxLines: 2, maxBytes: 1_000 },
    ),
  )

  it.live("marks results that fit without changing their content", () =>
    withStore((output) =>
      Effect.gen(function* () {
        const content = [{ type: "text" as const, text: "small" }]
        expect(yield* output.truncate(sessionID, { content })).toEqual({ content, metadata: { truncated: false } })
      }),
    ),
  )

  it.live("does not count a trailing newline as another line", () =>
    withStore(
      (output) =>
        Effect.gen(function* () {
          expect(yield* output.truncate(sessionID, { content: "one\ntwo\n" })).toEqual({
            content: "one\ntwo\n",
            metadata: { truncated: false },
          })
        }),
      { maxLines: 2, maxBytes: 1_000 },
    ),
  )

  it.live("reports a trailing newline omitted by the byte limit", () =>
    withStore(
      (output) =>
        Effect.gen(function* () {
          const result = yield* output.truncate(sessionID, { content: "one\n" })
          expect(result.content).toEqual([
            { type: "text", text: "one" },
            { type: "text", text: expect.stringMatching(/^\.\.\. 1 byte truncated; full content saved to /) },
          ])
        }),
      { maxLines: 2, maxBytes: 3 },
    ),
  )

  it.live("hard-caps each archive without claiming the full output was saved", () =>
    withStore(
      (output, fs) =>
        Effect.gen(function* () {
          const result = yield* output.truncate(sessionID, { content: "abcdefghi" })
          const outputPath = result.metadata?.outputPath
          expect(typeof outputPath).toBe("string")
          if (typeof outputPath !== "string") return
          expect(Buffer.byteLength(yield* fs.readFileString(outputPath))).toBe(5)
          expect(yield* fs.readFileString(outputPath)).toBe("abcde")
          expect(path.basename(outputPath)).toMatch(/^tool_[0-9a-f]{12}[0-9A-Za-z]{14}_[0-9a-f]{32}$/)
          expect(path.basename(outputPath)).not.toContain(sessionID)
          expect(result.metadata).toMatchObject({
            truncated: true,
            outputArchiveComplete: false,
            outputArchivedBytes: 5,
            outputOriginalBytes: 9,
          })
          expect(result.content).toEqual([
            {
              type: "text",
              text: `... 9 bytes truncated; archive capped at 5 of 9 bytes in ${outputPath} ...`,
            },
          ])
        }),
      {
        maxLines: 100,
        maxBytes: 3,
        maxArchiveBytes: 5,
        maxArchiveFiles: 10,
        maxArchiveTotalBytes: 100,
        maxSessionArchiveFiles: 10,
        maxSessionArchiveBytes: 100,
      },
    ),
  )

  it.live("evicts the oldest archives within one session", () =>
    withStore(
      (output, fs, root) =>
        Effect.gen(function* () {
          const files = yield* Effect.forEach(["first", "second", "third"], (value) =>
            output
              .truncate(sessionID, { content: `${value}\nomitted` })
              .pipe(Effect.map((result) => result.metadata?.outputPath)),
          )
          expect(files.every((file) => typeof file === "string")).toBe(true)
          if (!files.every((file): file is string => typeof file === "string")) return
          expect(yield* fs.exists(files[0])).toBe(false)
          expect(yield* fs.exists(files[1])).toBe(true)
          expect(yield* fs.exists(files[2])).toBe(true)
          expect(yield* fs.readDirectory(path.join(root, ToolOutput.DIRECTORY))).toHaveLength(2)
        }),
      {
        maxLines: 1,
        maxBytes: 1_000,
        maxArchiveBytes: 100,
        maxArchiveFiles: 10,
        maxArchiveTotalBytes: 1_000,
        maxSessionArchiveFiles: 10,
        maxSessionArchiveBytes: 28,
      },
    ),
  )

  it.live("keeps concurrent cross-session archives within global byte and file quotas", () =>
    withStore(
      (output, fs, root) =>
        Effect.gen(function* () {
          yield* Effect.forEach(
            Array.from({ length: 8 }, () => Session.ID.create()),
            (id) => output.truncate(id, { content: "1234\nx" }),
            { concurrency: "unbounded", discard: true },
          )
          const directory = path.join(root, ToolOutput.DIRECTORY)
          const entries = yield* fs.readDirectory(directory)
          const sizes = yield* Effect.forEach(entries, (entry) =>
            fs.stat(path.join(directory, entry)).pipe(Effect.map((info) => Number(info.size))),
          )
          expect(entries.length).toBeLessThanOrEqual(2)
          expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(12)
        }),
      {
        maxLines: 1,
        maxBytes: 1_000,
        maxArchiveBytes: 10,
        maxArchiveFiles: 2,
        maxArchiveTotalBytes: 12,
        maxSessionArchiveFiles: 2,
        maxSessionArchiveBytes: 12,
      },
    ),
  )

  it.live("cleanup converges existing archives to session and global quotas", () =>
    withStore((output, fs, root) =>
      Effect.gen(function* () {
        yield* output.transform((draft) =>
          draft.configure({
            maxLines: 1,
            maxBytes: 1_000,
            maxArchiveBytes: 100,
            maxArchiveFiles: 10,
            maxArchiveTotalBytes: 1_000,
            maxSessionArchiveFiles: 10,
            maxSessionArchiveBytes: 1_000,
          }),
        )
        const other = Session.ID.create()
        yield* Effect.forEach(
          [sessionID, sessionID, sessionID, other, other],
          (id) => output.truncate(id, { content: "a\nb" }),
          { discard: true },
        )
        yield* output.transform((draft) =>
          draft.configure({
            maxArchiveFiles: 2,
            maxArchiveTotalBytes: 6,
            maxSessionArchiveFiles: 1,
            maxSessionArchiveBytes: 3,
          }),
        )
        yield* output.cleanup()
        const entries = yield* fs.readDirectory(path.join(root, ToolOutput.DIRECTORY))
        expect(entries).toHaveLength(2)
        expect(entries.filter((entry) => entry.endsWith(Hash.sha256(sessionID).slice(0, 32)))).toHaveLength(1)
        expect(entries.filter((entry) => entry.endsWith(Hash.sha256(other).slice(0, 32)))).toHaveLength(1)
      }),
    ),
  )

  it.live("authorizes only exact regular archives owned by the current Session", () =>
    withStore(
      (output, fs, root) =>
        Effect.gen(function* () {
          const own = yield* output.truncate(sessionID, { content: "own\nomitted" })
          const otherID = Session.ID.create()
          const foreign = yield* output.truncate(otherID, { content: "foreign\nomitted" })
          const ownPath = own.metadata?.outputPath
          const foreignPath = foreign.metadata?.outputPath
          expect(typeof ownPath).toBe("string")
          expect(typeof foreignPath).toBe("string")
          if (typeof ownPath !== "string" || typeof foreignPath !== "string") return

          expect(yield* output.access({ sessionID, absolute: ownPath, canonical: ownPath })).toBe("archive")
          expect(yield* output.access({ sessionID: otherID, absolute: ownPath, canonical: ownPath })).toBe("protected")
          expect(yield* output.access({ sessionID, absolute: foreignPath, canonical: foreignPath })).toBe("protected")

          const directory = path.join(root, ToolOutput.DIRECTORY)
          expect(yield* output.access({ sessionID, absolute: directory, canonical: directory })).toBe("protected")
          const nested = path.join(directory, "nested", "archive")
          expect(yield* output.access({ sessionID, absolute: nested, canonical: nested })).toBe("protected")
          expect(yield* output.access({ sessionID, absolute: root, canonical: root })).toBe("protected")
          const unrelated = path.join(path.dirname(root), "unrelated")
          expect(yield* output.access({ sessionID, absolute: unrelated, canonical: unrelated })).toBe("unrelated")

          const legacy = path.join(directory, `${Identifier.ascending("tool")}_${Hash.sha256(sessionID).slice(0, 16)}`)
          yield* fs.writeFileString(legacy, "legacy")
          expect(yield* output.access({ sessionID, absolute: legacy, canonical: legacy })).toBe("protected")
        }),
      { maxLines: 1, maxBytes: 1_000 },
    ),
  )

  it.live("rejects an archive-shaped symlink even when its name matches the current Session", () =>
    withStore((output, filesystem, root) => {
      if (process.platform === "win32") return Effect.void
      return Effect.gen(function* () {
        const directory = path.join(root, ToolOutput.DIRECTORY)
        const target = path.join(path.dirname(root), "outside-output")
        const linked = path.join(directory, `${Identifier.ascending("tool")}_${Hash.sha256(sessionID).slice(0, 32)}`)
        yield* Effect.promise(async () => {
          await fs.writeFile(target, "outside")
          await fs.symlink(target, linked)
        })
        expect(yield* filesystem.readDirectoryEntries(directory)).toContainEqual({
          name: path.basename(linked),
          type: "symlink",
        })
        expect(yield* output.access({ sessionID, absolute: linked, canonical: target })).toBe("protected")
      })
    }),
  )

  it.live("repairs archive permissions without following archive-shaped symlinks", () =>
    withStore((output, _filesystem, root) => {
      if (process.platform === "win32") return Effect.void
      return Effect.gen(function* () {
        const directory = path.join(root, ToolOutput.DIRECTORY)
        const regular = path.join(directory, Identifier.create("tool", "ascending", 2 ** 36 + 2))
        const linked = path.join(directory, Identifier.create("tool", "ascending", 2 ** 36 + 3))
        const outside = path.join(path.dirname(root), "outside-permissions")
        yield* Effect.promise(async () => {
          await fs.writeFile(regular, "archive", { mode: 0o644 })
          await fs.chmod(regular, 0o644)
          await fs.writeFile(outside, "outside", { mode: 0o644 })
          await fs.chmod(outside, 0o644)
          await fs.symlink(outside, linked)
        })

        yield* output.cleanup()

        const info = yield* Effect.promise(async () => ({
          directory: await fs.stat(directory),
          regular: await fs.stat(regular),
          outside: await fs.stat(outside),
          linked: await fs.lstat(linked),
        }))
        expect(info.directory.mode & 0o777).toBe(0o700)
        expect(info.regular.mode & 0o777).toBe(0o600)
        expect(info.outside.mode & 0o777).toBe(0o644)
        expect(info.linked.isSymbolicLink()).toBe(true)
      })
    }),
  )

  it.live("uses file modification time when IDs wrap", () =>
    withStore((output, fs, root) =>
      Effect.gen(function* () {
        const directory = path.join(root, ToolOutput.DIRECTORY)
        const old = path.join(directory, Identifier.create("tool", "ascending", 2 ** 36 - 1))
        const recent = path.join(directory, Identifier.create("tool", "ascending", 2 ** 36 + 1))
        yield* fs.ensureDir(directory)
        yield* fs.writeFileString(old, "old")
        yield* fs.writeFileString(recent, "recent")
        yield* fs.utimes(old, new Date(), new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000))
        yield* output.cleanup()
        expect(yield* fs.exists(old)).toBe(false)
        expect(yield* fs.exists(recent)).toBe(true)
      }),
    ),
  )
})
