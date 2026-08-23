export * as ToolOutput from "./tool-output.js"

import path from "path"
import type { Tool } from "@opencode-ai/schema/tool"
import { Context, Duration, Effect, Layer, Option, Schedule } from "effect"
import { makeGlobalNode, makeLocationNode } from "@opencode-ai/util/effect/app-node"
import { FSUtil } from "@opencode-ai/util/fs-util"
import { Global } from "@opencode-ai/util/global"
import { Hash } from "@opencode-ai/util/hash"
import { KeyedMutex } from "./effect/keyed-mutex.js"
import { Identifier } from "./id/id.js"
import { SessionSchema } from "./session/schema.js"
import { State } from "./state.js"

export const MAX_LINES = 2_000
export const MAX_BYTES = 50 * 1024 // 50 KiB
export const RETENTION = Duration.days(7)
export const DIRECTORY = "tool-output"
export const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024
export const MAX_ARCHIVE_FILES = 256
export const MAX_ARCHIVE_TOTAL_BYTES = 256 * 1024 * 1024
export const MAX_SESSION_ARCHIVE_FILES = 32
export const MAX_SESSION_ARCHIVE_BYTES = 32 * 1024 * 1024

type Result = Tool.Result

type Limits = {
  maxLines: number
  maxBytes: number
  maxArchiveBytes: number
  maxArchiveFiles: number
  maxArchiveTotalBytes: number
  maxSessionArchiveFiles: number
  maxSessionArchiveBytes: number
}

const defaultLimits = (): Limits => ({
  maxLines: MAX_LINES,
  maxBytes: MAX_BYTES,
  maxArchiveBytes: MAX_ARCHIVE_BYTES,
  maxArchiveFiles: MAX_ARCHIVE_FILES,
  maxArchiveTotalBytes: MAX_ARCHIVE_TOTAL_BYTES,
  maxSessionArchiveFiles: MAX_SESSION_ARCHIVE_FILES,
  maxSessionArchiveBytes: MAX_SESSION_ARCHIVE_BYTES,
})

export type Draft = {
  configure: (limits: Partial<Limits>) => void
}

export type Access = "unrelated" | "archive" | "protected"

export interface AccessInput {
  readonly sessionID: SessionSchema.ID
  /** Absolute lexical path supplied to the filesystem tool. */
  readonly absolute: string
  /** Canonical path after following existing symlinks and junctions. */
  readonly canonical: string
}

export interface Interface extends State.Transformable<Draft> {
  readonly truncate: (sessionID: SessionSchema.ID, result: Result) => Effect.Effect<Result>
  readonly access: (input: AccessInput) => Effect.Effect<Access>
  readonly cleanup: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ToolOutput") {}

// Location services share the user data directory, so quota inspection and mutation
// must share one process-local lock keyed by that directory.
const archiveLocks = KeyedMutex.makeUnsafe<string>()
const archivePattern = /^tool_[0-9a-f]{12}[0-9A-Za-z]{14}(?:_([0-9a-f]{16}|[0-9a-f]{32}))?$/

const cleanup = Effect.fn("ToolOutput.cleanup")((fs: FSUtil.Interface, directory: string, limits = defaultLimits()) =>
  archiveLocks.withLock(FSUtil.normalizePath(directory))(
    Effect.gen(function* () {
      yield* secureDirectory(fs, directory).pipe(Effect.orDie)
      const existing = yield* archives(fs, directory)
      const expired = new Set(
        existing.filter((item) => item.modified < Date.now() - Duration.toMillis(RETENTION)).map((item) => item.file),
      )
      yield* Effect.forEach(expired, (file) => fs.remove(file, { force: true }).pipe(Effect.orDie), {
        concurrency: 1,
        discard: true,
      })
      const removed = quota(
        existing.filter((item) => !expired.has(item.file)),
        limits,
      )
      yield* Effect.forEach(removed, (file) => fs.remove(file, { force: true }).pipe(Effect.orDie), {
        concurrency: 1,
        discard: true,
      })
    }),
  ),
)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const directory = path.join(global.data, DIRECTORY)
    yield* archiveLocks.withLock(FSUtil.normalizePath(directory))(secureDirectory(fs, directory)).pipe(Effect.orDie)
    const canonicalDirectory = yield* fs.realPath(directory).pipe(Effect.orDie)
    const state = State.create<Limits, Draft>({
      name: "tool-output",
      initial: defaultLimits,
      draft: (draft) => ({
        configure: (limits) => {
          if (limits.maxLines !== undefined) draft.maxLines = limits.maxLines
          if (limits.maxBytes !== undefined) draft.maxBytes = limits.maxBytes
          if (limits.maxArchiveBytes !== undefined) draft.maxArchiveBytes = limits.maxArchiveBytes
          if (limits.maxArchiveFiles !== undefined) draft.maxArchiveFiles = limits.maxArchiveFiles
          if (limits.maxArchiveTotalBytes !== undefined) draft.maxArchiveTotalBytes = limits.maxArchiveTotalBytes
          if (limits.maxSessionArchiveFiles !== undefined) draft.maxSessionArchiveFiles = limits.maxSessionArchiveFiles
          if (limits.maxSessionArchiveBytes !== undefined) draft.maxSessionArchiveBytes = limits.maxSessionArchiveBytes
        },
      }),
    })

    const truncate = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, result: Result) {
      const content =
        typeof result.content === "string" ? [{ type: "text" as const, text: result.content }] : (result.content ?? [])
      const text = content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n")
      const limits = state.get()
      const lines = text.split("\n")
      if (text.endsWith("\n")) lines.pop()
      const totalBytes = Buffer.byteLength(text, "utf-8")
      if (lines.length <= limits.maxLines && totalBytes <= limits.maxBytes) {
        if (result.metadata?.truncated !== undefined) return result
        return { ...result, metadata: { ...result.metadata, truncated: false } }
      }

      const kept: string[] = []
      let bytes = 0
      let hitBytes = false
      for (const line of lines.slice(0, limits.maxLines)) {
        const size = Buffer.byteLength(line, "utf-8") + (kept.length > 0 ? 1 : 0)
        if (bytes + size > limits.maxBytes) {
          hitBytes = true
          break
        }
        kept.push(line)
        bytes += size
      }
      if (!hitBytes && kept.length === lines.length && totalBytes > bytes) hitBytes = true
      const removed = hitBytes ? totalBytes - bytes : lines.length - kept.length
      const unit = hitBytes ? (removed === 1 ? "byte" : "bytes") : removed === 1 ? "line" : "lines"
      const archived = yield* archive(fs, directory, sessionID, text, limits)
      const marker = archived.complete
        ? `... ${removed} ${unit} truncated; full content saved to ${archived.file} ...`
        : `... ${removed} ${unit} truncated; archive capped at ${archived.bytes} of ${totalBytes} bytes in ${archived.file} ...`
      const bounded: Tool.Content[] = []
      let remaining = kept.join("\n").length
      let seenText = false
      let marked = false
      for (const item of content) {
        if (item.type === "file") {
          bounded.push(item)
          continue
        }
        if (seenText && remaining > 0) remaining--
        seenText = true
        if (remaining >= item.text.length) {
          bounded.push(item)
          remaining -= item.text.length
          continue
        }
        if (remaining > 0) bounded.push({ ...item, text: item.text.slice(0, remaining) })
        if (!marked) bounded.push({ type: "text", text: marker })
        remaining = 0
        marked = true
      }
      if (!marked) bounded.push({ type: "text", text: marker })
      return {
        ...result,
        content: bounded,
        metadata: {
          ...result.metadata,
          truncated: true,
          outputPath: archived.file,
          outputArchiveComplete: archived.complete,
          outputArchivedBytes: archived.bytes,
          outputOriginalBytes: totalBytes,
        },
      }
    })

    return Service.of({
      transform: state.transform,
      reload: state.reload,
      truncate,
      access: Effect.fnUntraced(function* (input: AccessInput) {
        const session = Hash.sha256(input.sessionID).slice(0, 32)
        const lexical = relationship(directory, input.absolute, session)
        const canonical = relationship(canonicalDirectory, input.canonical, session)
        if (lexical === "protected" || canonical === "protected") return "protected"
        if (lexical === "archive" && !(yield* regularArchive(fs, directory, input.absolute))) return "protected"
        if (canonical === "archive" && !(yield* regularArchive(fs, canonicalDirectory, input.canonical)))
          return "protected"
        if (lexical === "archive" || canonical === "archive") return "archive"
        return "unrelated"
      }),
      cleanup: () => cleanup(fs, directory, state.get()),
    })
  }),
)

type Archive = {
  readonly file: string
  readonly name: string
  readonly session: string | undefined
  readonly bytes: number
  readonly modified: number
}

const archive = Effect.fn("ToolOutput.archive")(
  (fs: FSUtil.Interface, directory: string, sessionID: SessionSchema.ID, text: string, limits: Limits) =>
    archiveLocks.withLock(FSUtil.normalizePath(directory))(
      Effect.gen(function* () {
        yield* secureDirectory(fs, directory).pipe(Effect.orDie)
        const session = Hash.sha256(sessionID).slice(0, 32)
        const encoded = Buffer.from(text, "utf-8")
        const maximum = Math.max(
          0,
          Math.floor(Math.min(limits.maxArchiveBytes, limits.maxArchiveTotalBytes, limits.maxSessionArchiveBytes)),
        )
        const end = utf8Boundary(encoded, Math.min(encoded.length, maximum))
        const body = encoded.subarray(0, end)
        const existing = yield* archives(fs, directory)
        const expired = new Set(
          existing.filter((item) => item.modified < Date.now() - Duration.toMillis(RETENTION)).map((item) => item.file),
        )
        yield* Effect.forEach(expired, (file) => fs.remove(file, { force: true }).pipe(Effect.orDie), {
          concurrency: 1,
          discard: true,
        })
        const retained = existing.filter((item) => !expired.has(item.file))
        const removed = quota(retained, limits)
        const normalized = retained.filter((item) => !removed.has(item.file))
        const sessionArchives = normalized.filter((item) => item.session === session)
        prune(sessionArchives, 1, body.length, limits.maxSessionArchiveFiles, limits.maxSessionArchiveBytes).forEach(
          (item) => removed.add(item.file),
        )
        prune(
          normalized.filter((item) => !removed.has(item.file)),
          1,
          body.length,
          limits.maxArchiveFiles,
          limits.maxArchiveTotalBytes,
        ).forEach((item) => removed.add(item.file))
        yield* Effect.forEach(removed, (file) => fs.remove(file, { force: true }).pipe(Effect.orDie), {
          concurrency: 1,
          discard: true,
        })
        const file = path.join(directory, `${Identifier.ascending("tool")}_${session}`)
        yield* fs.writeFile(file, body, { mode: 0o600 }).pipe(Effect.orDie)
        return { file, bytes: body.length, complete: body.length === encoded.length }
      }),
    ),
)

const archives = Effect.fn("ToolOutput.archives")(function* (fs: FSUtil.Interface, directory: string) {
  const entries = yield* fs.readDirectoryEntries(directory).pipe(
    Effect.map((entries) => entries.filter((entry) => entry.type === "file")),
    Effect.orElseSucceed(() => []),
  )
  return yield* Effect.forEach(
    entries.flatMap((entry): Array<{ readonly name: string; readonly session: string | undefined }> => {
      const match = entry.name.match(archivePattern)
      return match ? [{ name: entry.name, session: match[1] }] : []
    }),
    (entry) =>
      Effect.gen(function* () {
        const file = path.join(directory, entry.name)
        const info = yield* fs.stat(file).pipe(Effect.orElseSucceed(() => undefined))
        if (!info || info.type !== "File") return
        const archive: Archive = {
          file,
          name: entry.name,
          session: entry.session,
          bytes: Number(info.size),
          modified: Option.getOrUndefined(info.mtime)?.getTime() ?? 0,
        }
        return archive
      }),
    { concurrency: 8 },
  ).pipe(Effect.map((items) => items.filter((item): item is Archive => item !== undefined)))
})

const secureDirectory = Effect.fn("ToolOutput.secureDirectory")(function* (fs: FSUtil.Interface, directory: string) {
  yield* fs.ensureDir(directory)
  const entry = (yield* fs.readDirectoryEntries(path.dirname(directory))).find((entry) =>
    sameName(entry.name, path.basename(directory)),
  )
  if (!entry || entry.type !== "directory")
    return yield* Effect.die(new Error(`Tool output directory must not be a symbolic link: ${directory}`))
  if (process.platform === "win32") return
  yield* fs.chmod(directory, 0o700)
  yield* Effect.forEach(
    (yield* fs.readDirectoryEntries(directory)).filter(
      (entry) => entry.type === "file" && archivePattern.test(entry.name),
    ),
    (entry) =>
      fs
        .chmod(path.join(directory, entry.name), 0o600)
        .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.void)),
    { concurrency: 8, discard: true },
  )
})

function relationship(directory: string, candidate: string, session: string): Access {
  const root = path.resolve(directory)
  const target = path.resolve(candidate)
  const relative = path.relative(root, target)
  if (relative === "") return "protected"
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    return FSUtil.contains(target, root) ? "protected" : "unrelated"
  if (relative.includes(path.sep)) return "protected"
  const match = relative.match(archivePattern)
  return match?.[1] === session ? "archive" : "protected"
}

const regularArchive = Effect.fnUntraced(function* (fs: FSUtil.Interface, directory: string, candidate: string) {
  const name = path.basename(path.resolve(candidate))
  return yield* fs.readDirectoryEntries(directory).pipe(
    Effect.map((entries) => entries.some((entry) => sameName(entry.name, name) && entry.type === "file")),
    Effect.orElseSucceed(() => false),
  )
})

function sameName(first: string, second: string) {
  return process.platform === "win32" ? first.toLowerCase() === second.toLowerCase() : first === second
}

function quota(files: Archive[], limits: Limits) {
  const removed = new Set(files.filter((item) => item.bytes > limits.maxArchiveBytes).map((item) => item.file))
  const retained = files.filter((item) => !removed.has(item.file))
  new Set(retained.map((item) => item.session)).forEach((session) =>
    prune(
      retained.filter((item) => item.session === session),
      0,
      0,
      limits.maxSessionArchiveFiles,
      limits.maxSessionArchiveBytes,
    ).forEach((item) => removed.add(item.file)),
  )
  prune(
    retained.filter((item) => !removed.has(item.file)),
    0,
    0,
    limits.maxArchiveFiles,
    limits.maxArchiveTotalBytes,
  ).forEach((item) => removed.add(item.file))
  return removed
}

function prune(files: Archive[], incomingFiles: number, incomingBytes: number, maxFiles: number, maxBytes: number) {
  const sorted = files.toSorted((a, b) => a.modified - b.modified || a.name.localeCompare(b.name))
  const total = sorted.reduce((sum, item) => sum + item.bytes, 0)
  const excessFiles = Math.max(0, sorted.length + incomingFiles - maxFiles)
  const excessBytes = Math.max(0, total + incomingBytes - maxBytes)
  if (excessFiles === 0 && excessBytes === 0) return []
  const removed: Archive[] = []
  let bytes = 0
  for (const item of sorted) {
    if (removed.length >= excessFiles && bytes >= excessBytes) break
    removed.push(item)
    bytes += item.bytes
  }
  return removed
}

function utf8Boundary(bytes: Buffer, maximum: number) {
  if (maximum >= bytes.length) return bytes.length
  let end = maximum
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--
  return end
}

const cleanupLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    yield* cleanup(fs, path.join(global.data, DIRECTORY)).pipe(
      Effect.repeat(Schedule.spaced(Duration.hours(1))),
      Effect.forkScoped,
    )
  }),
)

const cleanupNode = makeGlobalNode({
  name: "tool-output-cleanup",
  layer: cleanupLayer,
  deps: [FSUtil.node, Global.node],
})

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [FSUtil.node, Global.node, cleanupNode],
})
