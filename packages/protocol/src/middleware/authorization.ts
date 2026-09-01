import { Context } from "effect"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { User } from "@opencode-ai/schema/user"
import { UnauthorizedError } from "../errors.js"

export class Principal extends Context.Service<Principal, { readonly userID: User.ID }>()(
  "@opencode/HttpApiPrincipal",
) {}

export class Authorization extends HttpApiMiddleware.Service<Authorization, { provides: Principal }>()(
  "@opencode/HttpApiAuthorization",
  { error: UnauthorizedError },
) {}
