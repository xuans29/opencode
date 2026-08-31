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

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const location = yield* Location.Service
    return Service.of({
      prepare: Effect.fn("Sandbox.prepare")(function* (input) {
        if (process.platform !== "linux")
          return yield* new Error({ message: `bwrap sandbox is only supported on Linux, received ${process.platform}` })

        const workspace = path.resolve(location.directory)
        if (workspace === path.parse(workspace).root)
          return yield* new Error({ message: "Refusing to use the filesystem root as the sandbox workspace" })

        const configured = process.env.OPENCODE_BWRAP_PATH
        const bwrap = configured ? which(configured, input.env) : which("bwrap", input.env, "/usr/local/bin")
        if (!bwrap) return yield* new Error({ message: "Unable to find bwrap" })

        return Bwrap.prepare({ ...input, bwrap, workspace })
      }),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Location.node] })
