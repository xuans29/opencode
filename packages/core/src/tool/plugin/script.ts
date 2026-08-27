export * as ScriptTool from "./script.js"

import { ToolFailure } from "@opencode-ai/ai"
import type { Context as PluginContext } from "@opencode-ai/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { Permission } from "../../permission.js"
import { Sandbox } from "../../sandbox/service.js"
import { Language } from "../../sandbox/types.js"
import { NonNegativeInt } from "../../schema.js"
import { Shell } from "../../shell.js"
import { ToolOutput } from "../../tool-output.js"

export const name = "script"
export const DEFAULT_TIMEOUT_MS = 2 * 60 * 1_000

export const Input = Schema.Struct({
  language: Language.annotate({ description: "Script language" }),
  script: Schema.String.annotate({ description: "Script path inside the project" }),
  args: Schema.optionalKey(Schema.Array(Schema.String)).annotate({ description: "Arguments passed to the script" }),
  workdir: Schema.optionalKey(Schema.String).annotate({
    description: "Project-relative working directory. Defaults to the project root.",
  }),
  timeout: Schema.optionalKey(NonNegativeInt).annotate({
    description: `Timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS}.`,
  }),
})

const Output = Schema.Struct({
  output: Schema.String,
  exit: Schema.optionalKey(Schema.Number),
  timeout: Schema.optionalKey(Schema.Boolean),
  truncated: Schema.Boolean,
})

export const Plugin = {
  id: "opencode.tool.script",
  effect: Effect.fn("ScriptTool.Plugin")(function* (ctx: PluginContext) {
    const permission = yield* Permission.Service
    const sandbox = yield* Sandbox.Service
    const shell = yield* Shell.Service

    yield* ctx.tool
      .transform((draft) =>
        draft.add({
          name,
          options: { codemode: false },
          description:
            "Run a Python or TypeScript file in the isolated script sandbox. The project is read-only, /work is session-writable, and network access is disabled.",
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* permission.assert({
                action: name,
                resources: [`${input.language} ${input.script}`],
                save: [`${input.language} *`],
                metadata: input,
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.messageID, id: context.id },
              })
              const info = yield* sandbox.create({
                sessionID: context.sessionID,
                language: input.language,
                script: input.script,
                args: input.args,
                workdir: input.workdir,
                timeout: input.timeout ?? DEFAULT_TIMEOUT_MS,
              })
              yield* context.progress({ shellID: info.id })
              const final = yield* shell
                .wait(info.id)
                .pipe(Effect.onInterrupt(() => shell.remove(info.id).pipe(Effect.ignore)))
              const latest = yield* shell.output(info.id, { cursor: Number.MAX_SAFE_INTEGER })
              const page = yield* shell.output(info.id, {
                cursor: Math.max(0, latest.size - ToolOutput.MAX_BYTES),
                limit: ToolOutput.MAX_BYTES,
              })
              const truncated = latest.size > ToolOutput.MAX_BYTES
              const output = `${page.output || "(no output)"}${
                truncated ? `\n\n[output truncated; full output saved to: ${info.file}]` : ""
              }`
              const result = {
                output,
                ...(final.exit !== undefined ? { exit: final.exit } : {}),
                ...(final.status === "timeout" ? { timeout: true } : {}),
                truncated,
              }
              return {
                output: result,
                content: output,
                metadata: {
                  shellID: info.id,
                  ...(result.exit !== undefined ? { exit: result.exit } : {}),
                  ...(result.timeout !== undefined ? { timeout: result.timeout } : {}),
                  truncated,
                },
              }
            }).pipe(
              Effect.mapError(
                (error) =>
                  new ToolFailure({ message: `Unable to run ${input.language} script: ${input.script}`, error }),
              ),
            ),
        }),
      )
      .pipe(Effect.orDie)
  }),
}
