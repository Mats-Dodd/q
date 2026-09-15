import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Config, Effect, FileSystem, Layer, Option, Path, type PlatformError } from "effect"
import type { SqlClient } from "effect/unstable/sql"

import type { TranscriptError, TranscriptRepository } from "@q/core"
import { Sql } from "./sql"

// SQLITE — the file on disk. One file holds every session; two processes can share it.

/** Where the database lives when `--db` is not given: `$Q_DB`, else `$XDG_DATA_HOME/q/q.db`, else `~/.local/share/q/q.db`. */
export const DbPath: Config.Config<string> = Config.String("Q_DB").pipe(
  Config.orElse(() =>
    Config.all([Config.option(Config.String("XDG_DATA_HOME")), Config.String("HOME")]).pipe(
      Config.map(([xdg, home]) => `${Option.getOrElse(xdg, () => `${home}/.local/share`)}/q/q.db`),
    ),
  ),
)

/** The `bun:sqlite` client on `filename`, once the directory of the file exists. `:memory:` has none. */
export const Sqlite = (filename: string): Layer.Layer<SqlClient.SqlClient, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
  Layer.unwrap(
    Effect.gen(function* () {
      if (filename !== ":memory:") {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        yield* fs.makeDirectory(path.dirname(filename), { recursive: true })
      }
      // WAL mode is on, so two processes can share the file. The busy wait is short because
      // `bun:sqlite` blocks the event loop while it waits; a timeout surfaces as a notice, not a hang.
      return SqliteClient.layer({ filename, busyTimeout: "1 second" })
    }),
  )

/** The repository on the SQLite file `filename`. What a host provides. */
export const Storage = (
  filename: string,
): Layer.Layer<TranscriptRepository, TranscriptError | PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
  Sql.pipe(Layer.provide(Sqlite(filename)))
