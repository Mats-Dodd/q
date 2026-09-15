import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"

export const initialSchema = Effect.gen(function* initialSchema() {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      cwd TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `
  yield* sql`CREATE INDEX session_cwd ON session (cwd, created_at)`

  yield* sql`
    CREATE TABLE transcript_event (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES session (id),
      kind TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `
  yield* sql`CREATE INDEX transcript_event_session ON transcript_event (session_id, seq)`
})
