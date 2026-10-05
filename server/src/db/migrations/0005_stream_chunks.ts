import { Effect } from "effect"
import { SqlClient } from "effect/sql"

/** A session stream's entries are chunks: `stream_messages` becomes `stream_chunks`. */
export default Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE stream_messages RENAME TO stream_chunks`
})
