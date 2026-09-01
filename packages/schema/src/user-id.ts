import { Schema } from "effect"
import { ascending } from "./identifier.js"
import { statics } from "./schema.js"

export const UserID = Schema.String.check(Schema.isStartsWith("usr_")).pipe(
  Schema.brand("User.ID"),
  statics((schema) => ({
    create: () => schema.make("usr_" + ascending()),
    local: schema.make("usr_local"),
  })),
)
export type UserID = typeof UserID.Type
