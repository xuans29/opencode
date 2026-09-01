import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20260901143216_user_session_ownership",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_v2\` ADD \`owner_id\` text DEFAULT 'usr_local' NOT NULL;`)
    })
  },
}

export default migration
