export * as Sandbox from "./service.js"

import path from "node:path"
import { makeLocationNode } from "@opencode-ai/util/effect/app-node"
import { Global } from "@opencode-ai/util/global"
import { Context, Effect, Layer } from "effect"
import { Location } from "../location.js"
import { Shell } from "../shell.js"
import { SessionSchema } from "../session/schema.js"
import { which } from "../util/which.js"
import { build } from "./bwrap.js"
import { prepare } from "./workspace.js"
import { Error, type Language } from "./types.js"

export interface Request {
  readonly sessionID: SessionSchema.ID
  readonly language: Language
  readonly script: string
  readonly args?: readonly string[]
  readonly workdir?: string
  readonly timeout: number
  readonly env?: NodeJS.ProcessEnv
  readonly runtime?: string
  readonly bwrap?: string
}

export interface Interface {
  readonly create: (input: Request) => Effect.Effect<Shell.Info, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Sandbox") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const global = yield* Global.Service
    const location = yield* Location.Service
    const shell = yield* Shell.Service

    const create = Effect.fn("Sandbox.create")(function* (input: Request) {
      const workspace = yield* prepare({
        project: location.directory,
        workRoot: path.join(global.data, "sandbox"),
        sessionID: input.sessionID,
        script: input.script,
        workdir: input.workdir,
      })
      const name = input.language === "python" ? "python3" : "bun"
      const runtime = input.runtime ?? which(name, input.env)
      if (!runtime) return yield* new Error({ message: `Sandbox runtime is unavailable: ${name}` })
      const process = build({
        language: input.language,
        workspace,
        runtime,
        args: input.args,
        bwrap: input.bwrap,
        env: input.env,
      })
      return yield* shell
        .createProcess({
          command: [name, workspace.script, ...(input.args ?? [])].join(" "),
          process,
          timeout: input.timeout,
          metadata: { sessionID: input.sessionID, sandbox: true },
        })
        .pipe(
          Effect.mapError(
            (cause) => new Error({ message: `Unable to start sandbox process with ${process.executable}`, cause }),
          ),
        )
    })

    return Service.of({ create })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Global.node, Location.node, Shell.node],
})
