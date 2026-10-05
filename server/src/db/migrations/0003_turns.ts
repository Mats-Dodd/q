import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE turns (
      id TEXT PRIMARY KEY NOT NULL,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `
  // At most one turn per session runs at a time, enforced by the database.
  yield* sql`CREATE UNIQUE INDEX turns_one_running_per_session ON turns (session_id) WHERE status = 'running'`
})
