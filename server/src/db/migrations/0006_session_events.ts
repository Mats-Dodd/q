import { Effect } from "effect"
import { SqlClient } from "effect/sql"

/**
 * One store: each session's events, numbered from 0 with no gaps. The session
 * stream, the model's history and turn state are projections of them, so the
 * tables that held those go. (No backfill: existing sessions start over.)
 */
export default Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE session_events (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      turn_id TEXT,
      event TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (session_id, seq)
    ) WITHOUT ROWID
  `
  yield* sql`DROP TABLE stream_chunks`
  yield* sql`DROP TABLE model_messages`
  yield* sql`DROP TABLE turns`
})
