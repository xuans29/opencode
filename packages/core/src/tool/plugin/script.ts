export * as ScriptTool from "./script.js"

import { ToolFailure } from "@opencode-ai/ai"
import type { Context as PluginContext } from "@opencode-ai/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { Location } from "../../location.js"
import { LocationMutation } from "../../location-mutation.js"
import { Permission } from "../../permission.js"
import { Sandbox } from "../../sandbox.js"
import { ToolExecutionPolicy } from "../execution-policy.js"

export const name = "script"
export const DEFAULT_TIMEOUT_MS = 2 * 60 * 1_000
export const MAX_TIMEOUT_MS = DEFAULT_TIMEOUT_MS

export const description = [
  "Execute Python or TypeScript code in an isolated Linux sandbox.",
  "The current project is mounted read-write at /workspace, while host files and environment variables are unavailable.",
  "Networking, background processes, package installation, custom images, and resource overrides are not supported.",
].join(" ")

const Timeout = Schema.Int.check(
  Schema.isBetween(
    { minimum: 1, maximum: MAX_TIMEOUT_MS },
    { message: `Timeout must be between 1 and ${MAX_TIMEOUT_MS} milliseconds` },
  ),
)

export const Input = Schema.Struct({
  language: Schema.Literals(["python", "typescript"]).annotate({
    description: "Script language to execute",
  }),
  code: Schema.String.check(Schema.isMinLength(1, { message: "Script code must not be empty" })).annotate({
    description: "Python or TypeScript source code",
  }),
  args: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "Arguments passed to the script",
  }),
  cwd: Schema.optionalKey(Schema.String).annotate({
    description: "Working directory relative to the current project. Defaults to the project root.",
  }),
  timeout: Schema.optionalKey(Timeout).annotate({
    description: `Timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS} and cannot exceed it.`,
  }),
})

export const Output = Schema.Struct({
  language: Input.fields.language,
  exitCode: Schema.Int,
  output: Schema.String,
  truncated: Schema.Boolean,
})
export type Output = typeof Output.Type

export const toModelOutput = (output: Output) =>
  [
    output.output || "Script completed with no output.",
    ...(output.truncated ? ["Output was truncated because it exceeded the sandbox output limit."] : []),
    `Script exited with code ${output.exitCode}.`,
  ].join("\n\n")

export const Plugin = {
  id: "opencode.tool.script",
  effect: Effect.fn("ScriptTool.Plugin")(function* (ctx: PluginContext) {
    const location = yield* Location.Service
    const mutation = yield* LocationMutation.Service
    const permission = yield* Permission.Service
    const sandbox = yield* Sandbox.Service

    yield* ctx.tool
      .transform((draft) =>
        draft.add(
          ToolExecutionPolicy.declareSandbox(
            {
              name,
              options: { codemode: false },
              description,
              input: Input,
              output: Output,
              execute: (input, context) =>
                Effect.gen(function* () {
                  if (!sandbox.enabled) return yield* new Sandbox.DisabledError()
                  const target = yield* mutation.resolve({ path: input.cwd ?? ".", kind: "directory" })
                  if (target.externalDirectory)
                    return yield* new ToolFailure({
                      message: "Script working directory must be inside the current project",
                    })

                  yield* permission.assert({
                    action: name,
                    resources: [input.language],
                    save: [input.language],
                    metadata: { language: input.language, cwd: input.cwd ?? "." },
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source: {
                      type: "tool",
                      messageID: context.messageID,
                      id: context.id,
                    },
                  })

                  const result = yield* sandbox.run({
                    sessionID: context.sessionID,
                    projectDirectory: location.directory,
                    profile: "script",
                    cwd: target.canonical,
                    command: input.language === "python" ? "python3" : "/bin/sh",
                    args:
                      input.language === "python"
                        ? ["-", ...(input.args ?? [])]
                        : [
                            "-c",
                            [
                              'file="$(mktemp /tmp/opencode-script-XXXXXX.ts)" || exit 1',
                              'cat > "$file"',
                              'exec bun --no-install --no-env-file run "$file" "$@"',
                            ].join("\n"),
                            "opencode-typescript",
                            ...(input.args ?? []),
                          ],
                    stdin: input.code,
                    timeout: input.timeout ?? DEFAULT_TIMEOUT_MS,
                  })
                  const output = {
                    language: input.language,
                    exitCode: result.exitCode,
                    output: result.output,
                    truncated: result.truncated,
                  }
                  return {
                    output,
                    content: toModelOutput(output),
                    metadata: {
                      language: output.language,
                      exitCode: output.exitCode,
                      truncated: output.truncated,
                    },
                  }
                }).pipe(Effect.mapError((error) => new ToolFailure({ message: "Unable to execute script", error }))),
            },
            "script",
          ),
        ),
      )
      .pipe(Effect.orDie)
  }),
}
