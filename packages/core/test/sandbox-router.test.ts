import { describe, expect, test } from "bun:test"
import { SandboxRouter } from "@opencode-ai/core/sandbox/router"

describe("SandboxRouter", () => {
  test.each([
    ["python test.py", "python", "test.py"],
    ["python3 test.py", "python", "test.py"],
    ["/usr/bin/python3 test.py", "python", "test.py"],
    ["bun test.ts", "typescript", "test.ts"],
    ["node test.js", "typescript", "test.js"],
    ["env python test.py", "python", "test.py"],
    ["bash -c 'python test.py'", "python", "test.py"],
    ["sh -c 'node test.js'", "typescript", "test.js"],
  ])("routes %s", (command, language, script) => {
    expect(SandboxRouter.route(command)).toEqual({
      language: language === "python" ? "python" : "typescript",
      script,
      args: [],
    })
  })

  test.each(["echo python", "grep python README.md", "python -c 'print(1)'", "python a.py && echo done"])(
    "does not route %s",
    (command) => expect(SandboxRouter.route(command)).toBeUndefined(),
  )

  test("preserves script arguments without invoking a shell", () => {
    expect(SandboxRouter.route("python scripts/test.py one 'two words'")).toEqual({
      language: "python",
      script: "scripts/test.py",
      args: ["one", "two words"],
    })
  })
})
