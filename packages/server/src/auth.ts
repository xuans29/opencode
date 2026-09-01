export * as ServerAuth from "./auth"

import { User } from "@opencode-ai/schema/user"
import { Context, Layer, Option, Redacted } from "effect"

export type DecodedCredentials =
  | { readonly type: "basic"; readonly username: string; readonly password: Redacted.Redacted }
  | { readonly type: "bearer"; readonly token: Redacted.Redacted }

export type Info = {
  readonly password: Option.Option<string>
  readonly username: string
  readonly users: ReadonlyArray<{ readonly id: User.ID; readonly apiKey: string }>
}

export class Config extends Context.Service<Config, Info>()("@opencode/ServerAuthConfig") {
  static configLayer(input: Pick<Info, "password"> & Partial<Pick<Info, "users">>) {
    return Layer.succeed(this, this.of({ ...input, username: "opencode", users: input.users ?? [] }))
  }

  static get layer() {
    return this.configLayer({ password: Option.none() })
  }
}

export function required(config: Info) {
  return (Option.isSome(config.password) && config.password.value !== "") || config.users.length > 0
}

export function authenticate(credentials: DecodedCredentials, config: Info) {
  if (credentials.type === "bearer") {
    const token = Redacted.value(credentials.token)
    return Option.fromNullishOr(config.users.find((user) => user.apiKey === token)?.id)
  }
  if (
    Option.isSome(config.password) &&
    credentials.username === config.username &&
    Redacted.value(credentials.password) === config.password.value
  )
    return Option.some(User.ID.local)
  return Option.none<User.ID>()
}

export function authorized(credentials: DecodedCredentials, config: Info) {
  return Option.isSome(authenticate(credentials, config))
}
