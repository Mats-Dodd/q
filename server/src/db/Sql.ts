import { Effect, FileSystem, Layer, Path, String } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { ServerConfig } from "../ServerConfig.ts"

/**
 * Bun SQLite client. Repositories only depend on the generic `SqlClient`, so the
 * Durable Object build swaps this layer for `@effect/sql-sqlite-do`.
 *
 * Columns are snake_case in SQL and camelCase in the domain.
 */
export const layer = Layer.unwrap(
  Effect.gen(function*() {
    const { dbPath } = yield* ServerConfig
    if (dbPath !== ":memory:") {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true })
    }
    return SqliteClient.layer({
      filename: dbPath,
      transformQueryNames: String.camelToSnake,
      transformResultNames: String.snakeToCamel
    })
  })
)
