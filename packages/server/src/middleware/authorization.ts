import { ServerAuth } from "../auth"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { UnauthorizedError } from "@opencode-ai/protocol/errors"
import { Authorization, Principal } from "@opencode-ai/protocol/middleware/authorization"
export { Authorization, Principal } from "@opencode-ai/protocol/middleware/authorization"
import { hasPtyConnectTicketURL } from "@opencode-ai/protocol/groups/pty"
import { Effect, Encoding, Layer, Option, Redacted } from "effect"
import { HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { and, eq } from "drizzle-orm"
import { Session } from "@opencode-ai/schema/session"
import { User } from "@opencode-ai/schema/user"

const AUTH_TOKEN_QUERY = "auth_token"
const WWW_AUTHENTICATE = 'Basic realm="Secure Area"'

function emptyCredential() {
  return { type: "basic" as const, username: "", password: Redacted.make("") }
}

function decodeCredential(input: string): Effect.Effect<ServerAuth.DecodedCredentials> {
  return Effect.fromResult(Encoding.decodeBase64String(input)).pipe(
    Effect.match({
      onFailure: emptyCredential,
      onSuccess: (header) => {
        const separator = header.indexOf(":")
        if (separator === -1) return emptyCredential()
        return {
          type: "basic" as const,
          username: header.slice(0, separator),
          password: Redacted.make(header.slice(separator + 1)),
        }
      },
    }),
  )
}

function credentialFromRequest(
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<ServerAuth.DecodedCredentials> {
  const url = new URL(request.url, "http://localhost")
  const token = url.searchParams.get(AUTH_TOKEN_QUERY)
  if (token) return decodeCredential(token)
  const match = /^Basic\s+(.+)$/i.exec(request.headers.authorization ?? "")
  if (match) return decodeCredential(match[1])
  const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? "")
  if (bearer) return Effect.succeed({ type: "bearer" as const, token: Redacted.make(bearer[1]) })
  return Effect.succeed(emptyCredential())
}

export function authorizedRequest(request: HttpServerRequest.HttpServerRequest, config: ServerAuth.Info) {
  return credentialFromRequest(request).pipe(Effect.map((credential) => ServerAuth.authorized(credential, config)))
}

function principalFromRequest(request: HttpServerRequest.HttpServerRequest, config: ServerAuth.Info) {
  if (!ServerAuth.required(config)) return Effect.succeed(Option.some(User.ID.local))
  return credentialFromRequest(request).pipe(Effect.map((credential) => ServerAuth.authenticate(credential, config)))
}

export const authorizationLayer = Layer.effect(
  Authorization,
  Effect.gen(function* () {
    const config = yield* ServerAuth.Config
    const db = (yield* Database.Service).db
    return Authorization.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        // Browsers cannot set headers on WebSocket upgrades, so a ticketed PTY connect skips
        // credential checks here; the connect handler consumes and validates the ticket.
        const url = new URL(request.url, "http://localhost")
        if (hasPtyConnectTicketURL(url))
          return yield* effect.pipe(Effect.provideService(Principal, { userID: User.ID.local }))
        const authenticated = yield* principalFromRequest(request, config)
        if (Option.isSome(authenticated)) {
          const userID = authenticated.value
          const match = /^\/api\/(?:experimental\/)?session\/(ses_[^/]+)/.exec(url.pathname)
          if (match) {
            const sessionID = Session.ID.make(match[1])
            const owned = yield* db
              .select({ id: SessionTable.id })
              .from(SessionTable)
              .where(and(eq(SessionTable.id, sessionID), eq(SessionTable.owner_id, userID)))
              .get()
              .pipe(Effect.orDie)
            if (!owned) return yield* unauthorizedError()
          }
          return yield* effect.pipe(Effect.provideService(Principal, { userID }))
        }
        yield* HttpEffect.appendPreResponseHandler((_request, response) =>
          Effect.succeed(HttpServerResponse.setHeader(response, "www-authenticate", WWW_AUTHENTICATE)),
        )
        return yield* unauthorizedError()
      }),
    )
  }),
)

function unauthorizedError() {
  return new UnauthorizedError({ message: "Authentication required" })
}
