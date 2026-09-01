import { expect, test } from "bun:test"
import { ServerAuth } from "@opencode-ai/server/auth"
import { Option, Redacted } from "effect"
import { User } from "@opencode-ai/schema/user"

test("accepts only the fixed opencode username", () => {
  const config = { password: Option.some("secret"), username: "opencode", users: [] }
  expect(
    ServerAuth.authorized({ type: "basic", username: "opencode", password: Redacted.make("secret") }, config),
  ).toBe(true)
  expect(ServerAuth.authorized({ type: "basic", username: "custom", password: Redacted.make("secret") }, config)).toBe(
    false,
  )
})

test("maps bearer keys to user principals", () => {
  const alice = User.ID.make("usr_alice")
  const config = {
    password: Option.none<string>(),
    username: "opencode",
    users: [{ id: alice, apiKey: "key-alice" }],
  }

  expect(ServerAuth.authenticate({ type: "bearer", token: Redacted.make("key-alice") }, config)).toEqual(
    Option.some(alice),
  )
  expect(ServerAuth.authenticate({ type: "bearer", token: Redacted.make("invalid") }, config)).toEqual(Option.none())
})
