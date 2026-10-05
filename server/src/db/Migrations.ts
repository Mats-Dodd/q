import { SqliteMigrator } from "@effect/sql-sqlite-bun"
import { Migrator } from "effect/sql"
import sessions from "./migrations/0001_sessions.ts"
import streamMessages from "./migrations/0002_stream_messages.ts"
import turns from "./migrations/0003_turns.ts"
import modelMessages from "./migrations/0004_model_messages.ts"
import streamChunks from "./migrations/0005_stream_chunks.ts"
import sessionEvents from "./migrations/0006_session_events.ts"

/**
 * Migrations are statically imported (not read from disk) so they survive
 * `bun build --compile` and Worker bundling.
 */
export const layer = SqliteMigrator.layer({
  loader: Migrator.fromRecord({
    "0001_sessions": sessions,
    "0002_stream_messages": streamMessages,
    "0003_turns": turns,
    "0004_model_messages": modelMessages,
    "0005_stream_chunks": streamChunks,
    "0006_session_events": sessionEvents
  })
})
