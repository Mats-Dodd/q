import { Effect } from "effect"
import { SqlClient } from "effect/sql"

/** A session's stream: one row per message, numbered from 0 with no gaps. (Renamed `stream_chunks` by 0005.) */
export default Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE stream_messages (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      chunk TEXT NOT NULL,
      PRIMARY KEY (session_id, seq)
    ) WITHOUT ROWID
  `
})
