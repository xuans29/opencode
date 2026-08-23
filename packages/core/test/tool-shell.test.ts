import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Config } from "@opencode-ai/core/config"
import { Environment } from "@opencode-ai/core/environment/index"
import { Location } from "@opencode-ai/core/location"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { Permission } from "@opencode-ai/core/permission"
import { Sandbox } from "@opencode-ai/core/sandbox"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Session } from "@opencode-ai/core/session"
import { Tool } from "@opencode-ai/core/tool"
import { ShellTool } from "@opencode-ai/core/tool/plugin/shell"
import { makeGlobalNode, makeLocationNode } from "@opencode-ai/util/effect/app-node"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { Global } from "@opencode-ai/util/global"
import { hostEnvironmentLayer } from "./fixture/environment"
import { tempGlobalLayer } from "./fixture/global"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { executeTool, registerToolPlugin, toolDefinitions, toolIdentity } from "./lib/tool"

const sessionID = Session.ID.make("ses_shell_tool_test")
const runs: Sandbox.RunInput[] = []
const assertions: Permission.AssertInput[] = []
let denyShell = false
let sandboxOutput = { exitCode: 0, output: "sandbox output", truncated: false }
let sandboxFailure: Sandbox.Error | undefined

const permission = permissionLayer({
  assert: (input) =>
    Effect.sync(() => assertions.push(input)).pipe(
      Effect.andThen(
        denyShell
          ? Effect.fail(
              new Permission.BlockedError({
                rules: [],
                permission: input.action,
                resources: input.resources,
              }),
            )
          : Effect.void,
      ),
    ),
})

const sandboxNode = (enabled = true) =>
  makeGlobalNode({
    service: Sandbox.Service,
    layer: Layer.succeed(
      Sandbox.Service,
      Sandbox.Service.of({
        enabled,
        run: (input) =>
          Effect.sync(() => runs.push(input)).pipe(
            Effect.andThen(() => (sandboxFailure ? Effect.fail(sandboxFailure) : Effect.succeed(sandboxOutput))),
          ),
      }),
    ),
    deps: [],
  })

const shellToolNode = makeLocationNode({
  name: "test/shell-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(ShellTool.Plugin)),
  deps: [Tool.node, Config.node, Environment.node, Location.node, LocationMutation.node, Permission.node, Sandbox.node],
})

const reset = () => {
  runs.length = 0
  assertions.length = 0
  denyShell = false
  sandboxOutput = { exitCode: 0, output: "sandbox output", truncated: false }
  sandboxFailure = undefined
}

const withTool = <A, E, R>(
  directory: string,
  body: (registry: Tool.Interface) => Effect.Effect<A, E, R>,
  enabled = true,
) => {
  const activeLocation = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
  )
  return Effect.gen(function* () {
    return yield* body(yield* Tool.Service)
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(LayerNode.group([Global.node, Tool.node, LocationMutation.node, shellToolNode]), [
        [Config.node, Config.testLayer()],
        [Environment.node, hostEnvironmentLayer],
        [Location.node, activeLocation],
        [Permission.node, permission],
        [Sandbox.node, sandboxNode(enabled)],
        [Global.node, tempGlobalLayer],
      ]),
    ),
  )
}

const call = (input: typeof ShellTool.Input.Type, id = "call-shell") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "shell", input },
})

const it = testEffect(Layer.empty)

describe("ShellTool", () => {
  test("accepts only a non-empty command with a bounded positive timeout", () => {
    const decode = Schema.decodeUnknownSync(ShellTool.Input)
    expect(decode({ command: "printf ok" })).toEqual({ command: "printf ok" })
    expect(decode({ command: "printf ok", timeout: 1 })).toEqual({ command: "printf ok", timeout: 1 })
    expect(() => decode({ command: "" })).toThrow()
    expect(() => decode({ command: "printf no", timeout: 0 })).toThrow()
    expect(() => decode({ command: "printf no", timeout: ShellTool.MAX_TIMEOUT_MS + 1 })).toThrow()
    expect(decode({ command: "sleep 10", background: true })).toEqual({ command: "sleep 10" })
  })

  it.live("registers the sandbox-only tool without unsafe controls", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            const definition = (yield* toolDefinitions(registry)).find((item) => item.name === "shell")
            expect(definition?.description).toContain("isolated Linux sandbox")
            expect(JSON.stringify(definition?.inputSchema)).not.toContain("background")
            expect(JSON.stringify(definition?.inputSchema)).not.toContain("network")
            expect(JSON.stringify(definition?.inputSchema)).not.toContain("image")
            expect(JSON.stringify(definition?.inputSchema)).not.toContain("memory")
            expect(JSON.stringify(definition?.inputSchema)).not.toContain("cpu")
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  it.live("rejects a host executor that tries to override the protected shell name", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        withTool(tmp.path, (registry) =>
          registry
            .transform((draft) =>
              draft.add({
                name: "shell",
                options: { codemode: false },
                description: "Unsafe host shell",
                input: Schema.Struct({ command: Schema.String }),
                execute: () => Effect.succeed({ content: "host" }),
              }),
            )
            .pipe(
              Effect.flip,
              Effect.tap((error) =>
                Effect.sync(() => {
                  expect(error).toBeInstanceOf(Tool.RegistrationError)
                  expect(error.message).toBe('Tool name "shell" requires a sandbox registration')
                }),
              ),
            ),
        ),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  it.live("routes commands through /bin/sh after permission", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            expect(yield* executeTool(registry, call({ command: "printf hello" }))).toMatchObject({
              status: "completed",
              output: {
                exit: 0,
                output: "sandbox output",
                truncated: false,
                status: "completed",
              },
              metadata: { exit: 0, truncated: false },
            })
            expect(runs).toEqual([
              {
                sessionID,
                projectDirectory: tmp.path,
                profile: "shell",
                cwd: tmp.path,
                command: "/bin/sh",
                args: ["-lc", "printf hello"],
                timeout: ShellTool.DEFAULT_TIMEOUT_MS,
              },
            ])
            expect(assertions).toMatchObject([{ action: "shell", resources: ["printf hello"] }])
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  it.live("keeps non-zero and truncated results useful", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        sandboxOutput = { exitCode: 7, output: "failed", truncated: true }
        return withTool(tmp.path, (registry) =>
          executeTool(registry, call({ command: "exit 7", timeout: 1_500 })).pipe(
            Effect.tap((settled) =>
              Effect.sync(() => {
                expect(settled).toMatchObject({
                  status: "completed",
                  output: { exit: 7, truncated: true, status: "completed" },
                  metadata: { exit: 7, truncated: true },
                })
                expect(settled.content?.[0]).toMatchObject({
                  type: "text",
                  text: expect.stringContaining("output truncated by sandbox limit"),
                })
                expect(runs[0]?.timeout).toBe(1_500)
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  it.live("does not request host directory permission for container paths", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withTool(tmp.path, (registry) => executeTool(registry, call({ command: "cd /tmp && pwd" }))).pipe(
          Effect.tap((settled) =>
            Effect.sync(() => {
              expect(settled).toMatchObject({ status: "completed" })
              expect(assertions.some((input) => input.action === "external_directory")).toBe(false)
              expect(assertions.some((input) => input.action === "shell")).toBe(true)
              expect(runs).toHaveLength(1)
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  it.live("rejects permission and outside workdirs before sandbox allocation", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            denyShell = true
            expect(yield* executeTool(registry, call({ command: "printf denied" }))).toMatchObject({
              status: "error",
            })
            expect(assertions).toHaveLength(1)
            expect(runs).toEqual([])

            reset()
            expect(
              yield* executeTool(
                registry,
                call({ command: "pwd", workdir: path.resolve(tmp.path, "..") }, "outside-call"),
              ),
            ).toMatchObject({ status: "error" })
            expect(assertions).toEqual([])
            expect(runs).toEqual([])
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  it.live("returns a useful timeout outcome", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        sandboxFailure = new Sandbox.TimeoutError({ timeout: 25 })
        return withTool(tmp.path, (registry) =>
          executeTool(registry, call({ command: "sleep 10", timeout: 25 })).pipe(
            Effect.tap((settled) =>
              Effect.sync(() => {
                expect(settled).toMatchObject({
                  status: "completed",
                  output: { timeout: true, truncated: false, status: "completed" },
                  metadata: { timeout: true, truncated: false },
                })
                expect(runs).toHaveLength(1)
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  it.live("fails closed when the sandbox service is disabled", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withTool(
          tmp.path,
          (registry) =>
            executeTool(registry, call({ command: "printf never-on-host" })).pipe(
              Effect.tap((settled) =>
                Effect.sync(() => {
                  expect(settled).toMatchObject({ status: "error" })
                  expect(assertions).toEqual([])
                  expect(runs).toEqual([])
                }),
              ),
            ),
          false,
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )
})
