import { Effect } from "effect"
import { SqlClient } from "effect/sql"

/**
 * A session's model log: the prompt messages the model has been given and has
 * produced, numbered from 0 with no gaps.
 */
export default Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE model_messages (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      turn_id TEXT NOT NULL,
      message TEXT NOT NULL,
      PRIMARY KEY (session_id, seq)
    ) WITHOUT ROWID
  `
})
