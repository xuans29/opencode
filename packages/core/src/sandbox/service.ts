export * as Sandbox from "./service.js"

import path from "path"
import { Context, Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "@opencode-ai/util/effect/app-node"
import { Location } from "../location.js"
import type { PreparedProcess } from "../shell.js"
import { which } from "../util/which.js"
import { Bwrap } from "./bwrap.js"

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
    const prepare = Effect.fn("Sandbox.prepare")(function* (input: PreparedProcess) {
      if (process.platform !== "linux")
        return yield* new Error({ message: `bwrap sandbox is only supported on Linux, received ${process.platform}` })

      const workspace = path.resolve(location.directory)
      if (workspace === path.parse(workspace).root)
        return yield* new Error({ message: "Refusing to use the filesystem root as the bwrap workspace" })

      const configured = process.env.OPENCODE_BWRAP_PATH
      const executable = configured ? which(configured, input.env) : which("bwrap", input.env, "/usr/local/bin")
      if (!executable)
        return yield* new Error({
          message: configured
            ? `Configured bwrap executable was not found: ${configured}`
            : "bwrap executable was not found in PATH or /usr/local/bin",
        })

      return Bwrap.prepare(input, workspace, executable)
    })
    return Service.of({ prepare })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Location.node] })
