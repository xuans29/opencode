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
    const limits = yield* Effect.try({
      try: () => ({
        cpuSeconds: positive("OPENCODE_SANDBOX_CPU_SECONDS", 120),
        memoryBytes: positive("OPENCODE_SANDBOX_MEMORY_MB", 1024) * 1024 * 1024,
        fileSizeBytes: positive("OPENCODE_SANDBOX_FILE_SIZE_MB", 256) * 1024 * 1024,
        openFiles: positive("OPENCODE_SANDBOX_OPEN_FILES", 256),
      }),
      catch: (cause) => new Error({ message: cause instanceof globalThis.Error ? cause.message : String(cause) }),
    }).pipe(Effect.orDie)
    const prepare = Effect.fn("Sandbox.prepare")(function* (input: PreparedProcess) {
      if (process.platform !== "linux")
        return yield* new Error({ message: `bwrap sandbox is only supported on Linux, received ${process.platform}` })

      const workspace = path.resolve(location.directory)
      if (workspace === path.parse(workspace).root)
        return yield* new Error({ message: "Refusing to use the filesystem root as the bwrap workspace" })
      const relative = path.relative(workspace, path.resolve(input.cwd))
      if (relative.startsWith("..") || path.isAbsolute(relative))
        return yield* new Error({ message: `Sandbox working directory is outside the workspace: ${input.cwd}` })

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
