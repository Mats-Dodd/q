import { SqliteMigrator } from "@effect/sql-sqlite-bun"
import { Migrator } from "effect/sql"
import sessions from "./migrations/0001_sessions.ts"

/**
 * Migrations are statically imported (not read from disk) so they survive
 * `bun build --compile` and Worker bundling.
 */
export const layer = SqliteMigrator.layer({
  loader: Migrator.fromRecord({
    "0001_sessions": sessions
  })
})
