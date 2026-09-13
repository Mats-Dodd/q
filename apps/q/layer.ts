import { BunServices } from "@effect/platform-bun"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import {
  type Agent,
  EchoAgent,
  type Resume,
  SessionTranscript,
  SqlTranscriptRepository,
  type Transcript,
  type TranscriptError,
  type TranscriptRepository,
} from "@q/core"
import { Config, Effect, FileSystem, Layer, Option, Path, type PlatformError } from "effect"

/** What one launch of `q` needs to know. Parsed from the command line in `index.tsx`. */
export interface Launch {
  /** Path of the SQLite file. All sessions share it. */
  readonly db: string
  /** The directory `q` was started in. Sessions belong to it. */
  readonly cwd: string
  readonly resume: Resume
}

/** Where the database lives when `--db` is not given: `$Q_DB`, else `$XDG_DATA_HOME/q/q.db`, else `~/.local/share/q/q.db`. */
export const DbPath: Config.Config<string> = Config.string("Q_DB").pipe(
  Config.orElse(() =>
    Config.all([Config.option(Config.string("XDG_DATA_HOME")), Config.string("HOME")]).pipe(
      Config.map(([xdg, home]) => `${Option.getOrElse(xdg, () => `${home}/.local/share`)}/q/q.db`),
    ),
  ),
)

/** The SQLite client, once the directory of the file exists. `:memory:` has none. */
const Sqlite = (db: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      if (db !== ":memory:") {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        yield* fs.makeDirectory(path.dirname(db), { recursive: true })
      }
      // WAL mode is on, so two terminals can share the file. The busy wait is short because
      // `bun:sqlite` blocks the event loop while it waits; a timeout surfaces as a notice, not a hang.
      return SqliteClient.layer({ filename: db, busyTimeout: "1 second" })
    }),
  )

/** The repository over `bun:sqlite`, at `db`. */
export const Storage = (
  db: string,
): Layer.Layer<TranscriptRepository, TranscriptError | PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
  SqlTranscriptRepository.pipe(Layer.provide(Sqlite(db)))

/**
 * The services the binary runs with. Swap Layers here; the program does not change. Closed over
 * Bun's platform services because the TUI builds it in its own runtime.
 */
export const AppLayer = (launch: Launch): Layer.Layer<Agent | Transcript, TranscriptError | PlatformError.PlatformError> =>
  Layer.mergeAll(EchoAgent, SessionTranscript(launch.resume, launch.cwd)).pipe(
    Layer.provide(Storage(launch.db)),
    Layer.provide(BunServices.layer),
  )
