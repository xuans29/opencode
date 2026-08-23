import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Location } from "@opencode-ai/core/location"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { Permission } from "@opencode-ai/core/permission"
import { Sandbox } from "@opencode-ai/core/sandbox"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Session } from "@opencode-ai/core/session"
import { Tool } from "@opencode-ai/core/tool"
import { ScriptTool } from "@opencode-ai/core/tool/plugin/script"
import { makeGlobalNode, makeLocationNode } from "@opencode-ai/util/effect/app-node"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { Global } from "@opencode-ai/util/global"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { executeTool, registerToolPlugin, toolDefinitions, toolIdentity } from "./lib/tool"

const sessionID = Session.ID.make("ses_script_tool_test")
const projectDirectory = AbsolutePath.make(path.resolve("test-script-project"))
const runs: Sandbox.RunInput[] = []
const assertions: Permission.AssertInput[] = []
let sandboxOutput = { exitCode: 0, output: "hello", truncated: false }
let denyScript = false
let sandboxEnabled = true

const sandbox = Layer.succeed(
  Sandbox.Service,
  Sandbox.Service.of({
    get enabled() {
      return sandboxEnabled
    },
    run: (input) =>
      Effect.sync(() => {
        runs.push(input)
        return sandboxOutput
      }),
  }),
)
const sandboxNode = makeGlobalNode({ service: Sandbox.Service, layer: sandbox, deps: [] })
const global = Layer.succeed(Global.Service, Global.Service.of(Global.make()))
const scriptToolNode = makeLocationNode({
  name: "test/script-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(ScriptTool.Plugin)),
  deps: [Tool.node, Location.node, LocationMutation.node, Permission.node, Sandbox.node, Global.node],
})
const activeLocation = Layer.succeed(Location.Service, Location.Service.of(location({ directory: projectDirectory })))
const permission = permissionLayer({
  assert: (input) =>
    Effect.sync(() => assertions.push(input)).pipe(
      Effect.andThen(
        denyScript
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
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Global.node, Tool.node, scriptToolNode]), [
    [Location.node, activeLocation],
    [Permission.node, permission],
    [Sandbox.node, sandboxNode],
    [Global.node, global],
  ]),
)

const reset = () => {
  runs.length = 0
  assertions.length = 0
  sandboxOutput = { exitCode: 0, output: "hello", truncated: false }
  denyScript = false
  sandboxEnabled = true
}

const call = (input: typeof ScriptTool.Input.Type, id = "call-script") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "script", input },
})

describe("ScriptTool", () => {
  test("accepts only Python or TypeScript with a bounded positive timeout", () => {
    const decode = Schema.decodeUnknownSync(ScriptTool.Input)
    expect(decode({ language: "python", code: "print('ok')" })).toEqual({
      language: "python",
      code: "print('ok')",
    })
    expect(decode({ language: "typescript", code: "console.log('ok')", timeout: 1 })).toEqual({
      language: "typescript",
      code: "console.log('ok')",
      timeout: 1,
    })
    expect(() => decode({ language: "javascript", code: "console.log('no')" })).toThrow()
    expect(() => decode({ language: "python", code: "" })).toThrow()
    expect(() => decode({ language: "python", code: "print('no')", timeout: 0 })).toThrow()
    expect(() => decode({ language: "python", code: "print('no')", timeout: ScriptTool.MAX_TIMEOUT_MS + 1 })).toThrow()
  })

  it.effect("registers without exposing network, background, image, or resource controls", () =>
    Effect.gen(function* () {
      const definitions = yield* toolDefinitions(yield* Tool.Service)
      const definition = definitions.find((item) => item.name === "script")
      expect(definition).toBeDefined()
      expect(JSON.stringify(definition?.inputSchema)).not.toContain("background")
      expect(JSON.stringify(definition?.inputSchema)).not.toContain("network")
      expect(JSON.stringify(definition?.inputSchema)).not.toContain("image")
      expect(JSON.stringify(definition?.inputSchema)).not.toContain("memory")
      expect(JSON.stringify(definition?.inputSchema)).not.toContain("cpu")
    }),
  )

  it.effect("runs Python source through sandbox stdin with default limits", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* Tool.Service
      expect(yield* executeTool(registry, call({ language: "python", code: "print('hello')", args: ["one"] }))).toEqual(
        {
          status: "completed",
          output: { language: "python", exitCode: 0, output: "hello", truncated: false },
          content: [{ type: "text", text: "hello\n\nScript exited with code 0." }],
          metadata: { language: "python", exitCode: 0, truncated: false },
        },
      )
      expect(runs).toEqual([
        {
          sessionID,
          projectDirectory,
          profile: "script",
          cwd: projectDirectory,
          command: "python3",
          args: ["-", "one"],
          stdin: "print('hello')",
          timeout: ScriptTool.DEFAULT_TIMEOUT_MS,
        },
      ])
      expect(assertions).toMatchObject([
        {
          action: "script",
          resources: ["python"],
          save: ["python"],
          sessionID,
          metadata: { language: "python", cwd: "." },
        },
      ])
    }),
  )

  it.effect("runs TypeScript with arguments, cwd, and an explicit timeout", () =>
    Effect.gen(function* () {
      reset()
      sandboxOutput = { exitCode: 7, output: "failed", truncated: true }
      const registry = yield* Tool.Service
      const settled = yield* executeTool(
        registry,
        call({
          language: "typescript",
          code: "console.log(Bun.argv)",
          args: ["one", "$(touch /tmp/should-not-run)"],
          cwd: "packages/core",
          timeout: 1_500,
        }),
      )
      expect(settled).toEqual({
        status: "completed",
        output: { language: "typescript", exitCode: 7, output: "failed", truncated: true },
        content: [
          {
            type: "text",
            text: "failed\n\nOutput was truncated because it exceeded the sandbox output limit.\n\nScript exited with code 7.",
          },
        ],
        metadata: { language: "typescript", exitCode: 7, truncated: true },
      })
      expect(runs).toEqual([
        {
          sessionID,
          projectDirectory,
          profile: "script",
          cwd: path.join(projectDirectory, "packages/core"),
          command: "/bin/sh",
          args: [
            "-c",
            [
              'file="$(mktemp /tmp/opencode-script-XXXXXX.ts)" || exit 1',
              'cat > "$file"',
              'exec bun --no-install --no-env-file run "$file" "$@"',
            ].join("\n"),
            "opencode-typescript",
            "one",
            "$(touch /tmp/should-not-run)",
          ],
          stdin: "console.log(Bun.argv)",
          timeout: 1_500,
        },
      ])
    }),
  )

  it.effect("rejects a cwd outside the project before permission or sandbox execution", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* Tool.Service
      expect(
        yield* executeTool(
          registry,
          call({ language: "python", code: "print('no')", cwd: path.resolve(projectDirectory, "..") }),
        ),
      ).toMatchObject({ status: "error" })
      expect(assertions).toEqual([])
      expect(runs).toEqual([])
    }),
  )

  it.effect("does not allocate a sandbox when script permission is denied", () =>
    Effect.gen(function* () {
      reset()
      denyScript = true
      const registry = yield* Tool.Service
      expect(yield* executeTool(registry, call({ language: "python", code: "print('no')" }))).toMatchObject({
        status: "error",
      })
      expect(assertions).toHaveLength(1)
      expect(runs).toEqual([])
    }),
  )

  it.effect("fails closed when the sandbox service is disabled", () =>
    Effect.gen(function* () {
      reset()
      sandboxEnabled = false
      const registry = yield* Tool.Service
      expect(yield* executeTool(registry, call({ language: "python", code: "print('no')" }))).toMatchObject({
        status: "error",
      })
      expect(assertions).toEqual([])
      expect(runs).toEqual([])
    }),
  )
})
