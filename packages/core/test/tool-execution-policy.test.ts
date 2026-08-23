import { describe, expect, test } from "bun:test"
import { ToolExecutionPolicy } from "@opencode-ai/core/tool/execution-policy"
import { Effect, Schema } from "effect"

describe("ToolExecutionPolicy", () => {
  test("routes registered sandbox execution classes to their profiles", () => {
    expect(ToolExecutionPolicy.decide({ class: "sandbox", profile: "shell" })).toEqual({
      target: "sandbox",
      profile: "shell",
    })
    expect(ToolExecutionPolicy.decide({ class: "sandbox", profile: "script" })).toEqual({
      target: "sandbox",
      profile: "script",
    })
  })

  test("keeps registered host tools on their executor without inferring from names", () => {
    expect(ToolExecutionPolicy.decide({ class: "host" })).toEqual({ target: "host" })
    expect(ToolExecutionPolicy.isProtected("shell")).toBe(true)
    expect(ToolExecutionPolicy.isProtected("script")).toBe(true)
    expect(ToolExecutionPolicy.isProtected("read")).toBe(false)
  })

  test("keeps sandbox registration metadata bound to the exact tool object", () => {
    const tool = ToolExecutionPolicy.declareSandbox(
      {
        name: "shell",
        description: "Protected shell",
        input: Schema.Struct({}),
        options: { codemode: false },
        execute: () => Effect.succeed({ content: "sandbox" }),
      },
      "shell",
    )

    expect(ToolExecutionPolicy.execution(tool)).toEqual({ class: "sandbox", profile: "shell" })
    expect(ToolExecutionPolicy.execution({ ...tool })).toEqual({ class: "host" })
  })
})
