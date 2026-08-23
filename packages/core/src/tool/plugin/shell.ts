export * as ShellTool from "./shell.js"

import { ToolFailure } from "@opencode-ai/ai"
import type { Context as PluginContext } from "@opencode-ai/plugin/effect/plugin"
import { Tool } from "@opencode-ai/schema/tool"
import { Effect, Schema } from "effect"
import { Config } from "../../config.js"
import { Environment } from "../../environment/index.js"
import { Location } from "../../location.js"
import { LocationMutation } from "../../location-mutation.js"
import { Permission } from "../../permission.js"
import { Sandbox } from "../../sandbox.js"
import { ShellParse } from "../../shell/parse.js"
import { ToolExecutionPolicy } from "../execution-policy.js"

export const name = "shell"
export const DEFAULT_TIMEOUT_MS = 2 * 60 * 1_000
export const MAX_TIMEOUT_MS = DEFAULT_TIMEOUT_MS

export const description = [
  "Execute a shell command in an isolated Linux sandbox using /bin/sh.",
  "The current project is mounted read-write at /workspace, while host files and environment variables are unavailable.",
  "Networking, background commands, package installation, custom images, and resource overrides are not supported.",
  "Output and execution time are bounded.",
].join(" ")

const Timeout = Schema.Int.check(
  Schema.isBetween(
    { minimum: 1, maximum: MAX_TIMEOUT_MS },
    { message: `Timeout must be between 1 and ${MAX_TIMEOUT_MS} milliseconds` },
  ),
)

export const Input = Schema.Struct({
  command: Schema.String.check(Schema.isMinLength(1, { message: "Shell command must not be empty" })).annotate({
    description: "Linux shell command string to execute",
  }),
  workdir: Schema.optionalKey(Schema.String).annotate({
    description: "Working directory relative to the current project. Defaults to the project root.",
  }),
  timeout: Schema.optionalKey(Timeout).annotate({
    description: `Timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS} and cannot exceed it.`,
  }),
})

export const Output = Schema.Struct({
  exit: Schema.optionalKey(Schema.Number),
  output: Schema.String,
  truncated: Schema.Boolean,
  timeout: Schema.optionalKey(Schema.Boolean),
  status: Schema.Literal("completed"),
})
export type Output = typeof Output.Type

const toolResult = (output: Output) => ({
  output,
  content: [
    { type: "text" as const, text: output.output },
    {
      type: "text" as const,
      text: output.timeout ? "Command timed out before completion." : `Command exited with code ${output.exit}.`,
    },
  ],
  metadata: {
    status: output.status,
    truncated: output.truncated,
    ...(output.exit !== undefined ? { exit: output.exit } : {}),
    ...(output.timeout !== undefined ? { timeout: output.timeout } : {}),
  },
})

export const Plugin = {
  id: "opencode.tool.shell",
  effect: Effect.fn("ShellTool.Plugin")(function* (ctx: PluginContext) {
    const environment = yield* Environment.Service
    const location = yield* Location.Service
    const mutation = yield* LocationMutation.Service
    const permission = yield* Permission.Service
    const config = yield* Config.Service
    const sandbox = yield* Sandbox.Service

    const authorize = Effect.fn("ShellTool.authorize")(function* (command: string, cwd: string, context: Tool.Context) {
      const target = yield* mutation.resolve({ path: cwd, kind: "directory" })
      if (target.externalDirectory)
        return yield* Effect.fail(new Error("Sandbox working directory must be inside the current project"))

      if (
        !(yield* permission.allowsAll({
          sessionID: context.sessionID,
          action: name,
          agent: context.agent,
        }))
      ) {
        const portable = Config.latest(yield* config.entries(), "experimental")?.portable_shell_scanner === true
        const parsed = yield* ShellParse.scan(command, "/bin/sh", target.canonical, { portable })
        const resources = parsed.commands.map((item) => item.resource)
        const save = parsed.commands.map((item) => item.save)
        yield* permission.assert({
          action: name,
          resources: resources.length > 0 ? resources : [command],
          save: save.length > 0 ? save : [command],
          sessionID: context.sessionID,
          agent: context.agent,
          source: {
            type: "tool",
            messageID: context.messageID,
            id: context.id,
          },
        })
      }

      const workdir = yield* Environment.typeFollowing(environment.files, target.canonical).pipe(
        Effect.catchTag("Environment.NotFound", () =>
          Effect.fail(new Error(`Working directory does not exist: ${target.canonical}`)),
        ),
      )
      if (workdir !== "directory")
        return yield* Effect.fail(new Error(`Working directory is not a directory: ${target.canonical}`))
      return target.canonical
    })

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
                  const cwd = yield* authorize(input.command, input.workdir ?? location.directory, context)
                  return yield* sandbox
                    .run({
                      sessionID: context.sessionID,
                      projectDirectory: location.directory,
                      profile: "shell",
                      cwd,
                      command: "/bin/sh",
                      args: ["-lc", input.command],
                      timeout: input.timeout ?? DEFAULT_TIMEOUT_MS,
                    })
                    .pipe(
                      Effect.map((result) =>
                        toolResult({
                          exit: result.exitCode,
                          output: `${result.output || "(no output)"}${result.truncated ? "\n\n[output truncated by sandbox limit]" : ""}`,
                          truncated: result.truncated,
                          status: "completed",
                        }),
                      ),
                      Effect.catchTag("Sandbox.TimeoutError", (error) =>
                        Effect.succeed(
                          toolResult({
                            output: `Command exceeded timeout of ${error.timeout} ms.`,
                            truncated: false,
                            timeout: true,
                            status: "completed",
                          }),
                        ),
                      ),
                    )
                }).pipe(
                  Effect.mapError(
                    (error) => new ToolFailure({ message: `Unable to execute command: ${input.command}`, error }),
                  ),
                ),
            },
            "shell",
          ),
        ),
      )
      .pipe(Effect.orDie)
  }),
}
