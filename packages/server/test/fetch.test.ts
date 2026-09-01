import { expect } from "bun:test"
import { Effect } from "effect"
import { User } from "@opencode-ai/schema/user"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

const options = {
  app: { version: "test-version" },
  database: { path: ":memory:" },
  fs: { filewatcher: false },
} as const

it.live("serves the HttpApi and enforces Basic auth like the Node server", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make({ ...options, password: "secret" })

    const denied = yield* Effect.promise(() => handler(new Request("http://opencode.local/api/health")))
    expect(denied.status).toBe(401)

    const response = yield* Effect.promise(() =>
      handler(
        new Request("http://opencode.local/api/health", {
          headers: { authorization: `Basic ${btoa("opencode:secret")}` },
        }),
      ),
    )
    expect(response.status).toBe(200)
    const body: unknown = yield* Effect.promise(() => response.json())
    if (typeof body !== "object" || body === null) throw new Error("Expected a health response object")
    expect((body as Record<string, unknown>)["healthy"]).toBe(true)
  }).pipe(Effect.scoped),
)

it.live("serves unauthenticated and answers CORS preflight when no password is configured", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make(options)

    const response = yield* Effect.promise(() => handler(new Request("http://opencode.local/api/health")))
    expect(response.status).toBe(200)

    const preflight = yield* Effect.promise(() =>
      handler(
        new Request("http://opencode.local/api/health", {
          method: "OPTIONS",
          headers: {
            origin: "http://localhost:3000",
            "access-control-request-method": "GET",
          },
        }),
      ),
    )
    expect(preflight.headers.get("access-control-allow-origin")).toBe("http://localhost:3000")
  }).pipe(Effect.scoped),
)

it.live("isolates session APIs by bearer user", () =>
  Effect.gen(function* () {
    const userA = User.ID.make("usr_alice")
    const userB = User.ID.make("usr_bob")
    const handler = yield* ServerFetch.make({
      ...options,
      users: [
        { id: userA, apiKey: "key-alice" },
        { id: userB, apiKey: "key-bob" },
      ],
    })
    const request = (path: string, apiKey: string, init?: RequestInit) =>
      handler(
        new Request(`http://opencode.local${path}`, {
          ...init,
          headers: {
            authorization: `Bearer ${apiKey}`,
            ...init?.headers,
          },
        }),
      )

    const created = yield* Effect.promise(() =>
      request("/api/session", "key-alice", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    )
    expect(created.status).toBe(200)
    const session = ((yield* Effect.promise(() => created.json())) as { data: { id: string } }).data

    const aliceList = yield* Effect.promise(() => request("/api/session", "key-alice"))
    expect(aliceList.status).toBe(200)
    expect(
      ((yield* Effect.promise(() => aliceList.json())) as { data: { id: string }[] }).data.map((item) => item.id),
    ).toContain(session.id)

    const bobList = yield* Effect.promise(() => request("/api/session", "key-bob"))
    expect(bobList.status).toBe(200)
    expect(
      ((yield* Effect.promise(() => bobList.json())) as { data: { id: string }[] }).data.map((item) => item.id),
    ).not.toContain(session.id)

    const denied = yield* Effect.promise(() => request(`/api/session/${session.id}`, "key-bob"))
    expect(denied.status).toBe(401)

    const allowed = yield* Effect.promise(() => request(`/api/session/${session.id}`, "key-alice"))
    expect(allowed.status).toBe(200)
  }).pipe(Effect.scoped),
)

// Pins the eager-boot guarantee: the application layer is built before the handler returns, so
// an aborted first request cannot interrupt layer construction and wedge every later request
// (the Effect-TS/effect#6319 failure class that lazy first-request builds are prone to).
it.live("stays serviceable when the first request aborts", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make(options)

    const aborted = yield* Effect.promise(() => {
      const controller = new AbortController()
      const first = handler(new Request("http://opencode.local/api/health", { signal: controller.signal }))
      controller.abort()
      return first.then(
        () => "resolved" as const,
        () => "rejected" as const,
      )
    })
    expect(["resolved", "rejected"]).toContain(aborted)

    const second = yield* Effect.promise(() => handler(new Request("http://opencode.local/api/health")))
    expect(second.status).toBe(200)
  }).pipe(Effect.scoped),
)
