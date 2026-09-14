import { BunHttpClient, BunHttpServer, BunServices } from "@effect/platform-bun"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Client, Transport, type TransportError, open } from "@q/client"
import { Agent, type Resume, type TranscriptError, TranscriptRepository } from "@q/core"
import { ApiLayer, Sessions, SessionsHandlers, SqlTranscriptRepository } from "@q/server"
import { Config, Effect, FileSystem, Layer, Option, Path, type PlatformError } from "effect"
import { type HttpServerError, HttpRouter } from "effect/unstable/http"

// LAYERS — the composition root. The program does not change when a Layer here does.

/** What one launch of the TUI needs to know. Parsed from the command line in `index.tsx`. */
export interface Launch {
  /** Path of the SQLite file, when the server runs in this process. All sessions share it. */
  readonly db: string
  /** The directory `q` was started in. Sessions belong to it. */
  readonly cwd: string
  readonly resume: Resume
  /** A server to talk to instead of running one here. */
  readonly server: Option.Option<string>
}

/** Where the database lives when `--db` is not given: `$Q_DB`, else `$XDG_DATA_HOME/q/q.db`, else `~/.local/share/q/q.db`. */
export const DbPath: Config.Config<string> = Config.String("Q_DB").pipe(
  Config.orElse(() =>
    Config.all([Config.option(Config.String("XDG_DATA_HOME")), Config.String("HOME")]).pipe(
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
      // WAL mode is on, so two processes can share the file. The busy wait is short because
      // `bun:sqlite` blocks the event loop while it waits; a timeout surfaces as a notice, not a hang.
      return SqliteClient.layer({ filename: db, busyTimeout: "1 second" })
    }),
  )

/** The repository over `bun:sqlite`, at `db`. */
export const Storage = (
  db: string,
): Layer.Layer<TranscriptRepository, TranscriptError | PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
  SqlTranscriptRepository.pipe(Layer.provide(Sqlite(db)))

/** The server's handlers over storage at `db` and the echo agent. Swap the agent here. */
export const Handlers = (db: string) =>
  SessionsHandlers.pipe(
    Layer.provide(Sessions.layer()),
    Layer.provide(Layer.mergeAll(Agent.Echo("30 millis"), Storage(db))),
  )

/** `q serve`: the API on a socket. */
export const Serve = (db: string, port: number): Layer.Layer<never, TranscriptError | PlatformError.PlatformError | HttpServerError.ServeError> =>
  HttpRouter.serve(ApiLayer).pipe(
    Layer.provide(Handlers(db)),
    Layer.provide(BunHttpServer.layer({ port, hostname: "127.0.0.1" })),
    Layer.provide(BunServices.layer),
  )

/**
 * The TUI's transport for this launch. Opens the session first: an unknown id fails the Layer, which
 * the screen shows as a crash. With `--server`, over HTTP; otherwise the server runs in this process
 * and the client reaches it through its handlers, with no socket.
 */
export const TransportLayer = (launch: Launch): Layer.Layer<Transport, TransportError | TranscriptError | PlatformError.PlatformError> =>
  Option.match(launch.server, {
    onSome: (url) =>
      Layer.unwrap(
        Effect.gen(function* () {
          const client = yield* Client.http(url)
          const session = yield* open(client, launch.cwd, launch.resume)
          return Transport.Http(url, session.id)
        }),
      ).pipe(Layer.provide(BunHttpClient.layer)),
    onNone: () =>
      Layer.unwrap(
        Effect.gen(function* () {
          const client = yield* Client.local
          const session = yield* open(client, launch.cwd, launch.resume)
          return Transport.Local(session.id)
        }),
      ).pipe(Layer.provide(Handlers(launch.db)), Layer.provide(BunHttpServer.layerHttpServices)),
  })
