export * as Sandbox from "./service.js"

import path from "path"
import type { ShellCreateBefore } from "@opencode-ai/plugin/effect/shell"
import { makeLocationNode } from "@opencode-ai/util/effect/app-node"
import { Context, Effect, Layer, Schema } from "effect"
import { Location } from "../location.js"
import type { Shell } from "../shell.js"
import { which } from "../util/which.js"
import { build } from "./bwrap.js"

export class Error extends Schema.TaggedError<Error>()("Sandbox.Error", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly prepare: (input: ShellCreateBefore) => Effect.Effect<Shell.PreparedProcess, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Sandbox") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const location = yield* Location.Service

    const prepare = Effect.fn("Sandbox.prepare")(function* (input: ShellCreateBefore) {
      if (process.platform !== "linux") return yield* new Error({ message: "Agent shell sandboxing requires Linux" })

      const workspace = path.resolve(location.directory)
      if (workspace === path.parse(workspace).root)
        return yield* new Error({ message: "Refusing to mount the filesystem root as a writable sandbox workspace" })

      const configured = process.env.OPENCODE_BWRAP_PATH?.trim()
      const executable = configured ? which(configured, process.env) : which("bwrap", process.env, "/usr/local/bin")
      if (!executable)
        return yield* new Error({
          message: configured
            ? `Configured bwrap executable is unavailable: ${configured}`
            : "bwrap is unavailable; install it at /usr/local/bin/bwrap or set OPENCODE_BWRAP_PATH",
        })

      return build({ executable, workspace, invocation: input })
    })

    return Service.of({ prepare })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Location.node],
})
