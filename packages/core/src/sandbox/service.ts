export * as Sandbox from "./service.js"

import path from "path"
import { Context, Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "@opencode-ai/util/effect/app-node"
import { Location } from "../location.js"
import type { PreparedProcess } from "../shell.js"
import { which } from "../util/which.js"
import { Bwrap } from "./bwrap.js"
import { Prlimit } from "./prlimit.js"

export class Error extends Schema.TaggedErrorClass<Error>()("Sandbox.Error", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly prepare: (input: PreparedProcess) => Effect.Effect<PreparedProcess, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Sandbox") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const location = yield* Location.Service
    const workspace = path.resolve(location.directory)
    const limits = yield* Effect.try({
      try: () => ({
        cpuSeconds: positive("OPENCODE_SANDBOX_CPU_SECONDS", 120),
        memoryBytes: positive("OPENCODE_SANDBOX_MEMORY_MB", 1024) * 1024 * 1024,
        fileSizeBytes: positive("OPENCODE_SANDBOX_FILE_SIZE_MB", 256) * 1024 * 1024,
        openFiles: positive("OPENCODE_SANDBOX_OPEN_FILES", 256),
      }),
      catch: (cause) => new Error({ message: cause instanceof globalThis.Error ? cause.message : String(cause) }),
    }).pipe(Effect.orDie)
    const validateHardlinks = yield* Effect.cached(
      Effect.gen(function* () {
        const executable = which("find", process.env, "/usr/bin")
        if (!executable)
          return yield* new Error({ message: "find executable is required to validate sandbox workspace hard links" })
        const hardlink = yield* Effect.tryPromise({
          try: () => externalHardlink(workspace, executable),
          catch: (cause) =>
            new Error({
              message: `Failed to validate sandbox workspace hard links: ${cause instanceof globalThis.Error ? cause.message : String(cause)}`,
            }),
        })
        if (!hardlink) return
        return yield* new Error({
          message: `Sandbox workspace contains a file hard-linked outside the workspace: ${hardlink}`,
        })
      }),
    )
    const prepare = Effect.fn("Sandbox.prepare")(function* (input: PreparedProcess) {
      if (process.platform !== "linux")
        return yield* new Error({ message: `bwrap sandbox is only supported on Linux, received ${process.platform}` })

      if (workspace === path.parse(workspace).root)
        return yield* new Error({ message: "Refusing to use the filesystem root as the bwrap workspace" })
      const relative = path.relative(workspace, path.resolve(input.cwd))
      if (relative.startsWith("..") || path.isAbsolute(relative))
        return yield* new Error({ message: `Sandbox working directory is outside the workspace: ${input.cwd}` })
      yield* validateHardlinks

      const configured = process.env.OPENCODE_BWRAP_PATH
      const executable = configured ? which(configured, input.env) : which("bwrap", input.env, "/usr/local/bin")
      if (!executable)
        return yield* new Error({
          message: configured
            ? `Configured bwrap executable was not found: ${configured}`
            : "bwrap executable was not found in PATH or /usr/local/bin",
        })

      const configuredPrlimit = process.env.OPENCODE_PRLIMIT_PATH
      const prlimit = configuredPrlimit
        ? which(configuredPrlimit, input.env)
        : which("prlimit", input.env, "/usr/bin")
      if (!prlimit)
        return yield* new Error({
          message: configuredPrlimit
            ? `Configured prlimit executable was not found: ${configuredPrlimit}`
            : "prlimit executable was not found in PATH or /usr/bin",
        })

      return Prlimit.prepare(Bwrap.prepare(input, workspace, executable), prlimit, limits)
    })
    return Service.of({ prepare })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Location.node] })

function positive(name: string, fallback: number) {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) throw new globalThis.Error(`${name} must be a positive integer`)
  return value
}

async function externalHardlink(workspace: string, executable: string) {
  const child = Bun.spawn(
    [executable, workspace, "-type", "f", "-links", "+1", "-printf", "%D\\0%i\\0%n\\0%p\\0"],
    {
      cwd: workspace,
      env: { LANG: "C" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exit !== 0) throw new globalThis.Error(stderr.trim() || `find exited with code ${exit}`)
  const values = stdout.split("\0")
  const rows = Array.from({ length: Math.floor(values.length / 4) }, (_, index) => ({
    key: `${values[index * 4]}:${values[index * 4 + 1]}`,
    links: Number(values[index * 4 + 2]),
    path: values[index * 4 + 3]!,
  }))
  const inodes = rows.reduce((result, row) => {
    const inode = result.get(row.key)
    result.set(row.key, inode ? { ...inode, entries: inode.entries + 1 } : { ...row, entries: 1 })
    return result
  }, new Map<string, { path: string; links: number; entries: number }>())
  return Array.from(inodes.values()).find((inode) => inode.entries < inode.links)?.path
}
