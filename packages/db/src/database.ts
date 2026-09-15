import { SqliteClient } from "@effect/sql-sqlite-bun"
import { DatabaseConfig } from "@q/config/database-config"
import { Effect, FileSystem, Layer, Path, type PlatformError, String } from "effect"
import type { SqlClient } from "effect/unstable/sql"

import { runMigrations } from "./migrations"

// DATABASE — one SQLite file holds every session; two processes can share it.

/**
 * The `bun:sqlite` client on `filename`. Columns are snake_case in SQLite and camelCase in
 * TypeScript. WAL mode is on, so two processes can share the file. The busy wait is short
 * because `bun:sqlite` blocks the event loop while it waits; a timeout surfaces as an error,
 * not a hang.
 */
export const makeSqliteClientLayer = (filename: string): Layer.Layer<SqlClient.SqlClient, never> =>
  SqliteClient.layer({
    filename,
    busyTimeout: "1 second",
    transformQueryNames: String.camelToSnake,
    transformResultNames: String.snakeToCamel,
  })

/** The client on the configured file, once the directory of the file exists. `:memory:` has none. */
export const SqliteClientLayer: Layer.Layer<
  SqlClient.SqlClient,
  PlatformError.PlatformError,
  DatabaseConfig | FileSystem.FileSystem | Path.Path
> = Layer.unwrap(
  Effect.gen(function* sqliteClientLayer() {
    const { path: filename } = yield* DatabaseConfig
    if (filename !== ":memory:") {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs.makeDirectory(path.dirname(filename), { recursive: true })
    }
    return makeSqliteClientLayer(filename)
  }),
)

/** Brings the schema up to date when built. Every process that opens the file does this; it is idempotent. */
export const MigrationsLayer = Layer.effectDiscard(runMigrations)

/** The client with its schema in place. What a host provides. */
export const DatabaseLayer = Layer.provideMerge(MigrationsLayer, SqliteClientLayer)
