import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Agent } from "../src/agent.js"

test("Agent.Color preserves configured colors at the public boundary", () => {
  const encode = Schema.encodeSync(Agent.Color)

  expect(encode("info")).toBe("info")
  expect(encode("custom-color")).toBe("custom-color")
})

test("Agent defaults ask before shell and script execution", () => {
  const permissions = Agent.Info.default(Agent.ID.make("build")).permissions
  const allow = permissions.findIndex((rule) => rule.action === "*" && rule.resource === "*")
  const shell = permissions.findIndex((rule) => rule.action === "shell" && rule.resource === "*")
  const script = permissions.findIndex((rule) => rule.action === "script" && rule.resource === "*")

  expect(shell).toBeGreaterThan(allow)
  expect(script).toBeGreaterThan(allow)
  expect(permissions[shell]).toEqual({ action: "shell", resource: "*", effect: "ask" })
  expect(permissions[script]).toEqual({ action: "script", resource: "*", effect: "ask" })
})
