import { BunHttpClient, BunHttpServer, BunServices } from "@effect/platform-bun"
import { Client, Transport, type TransportError, open } from "@q/client"
import { Agent, type Resume, type TranscriptError } from "@q/core"
import { Storage } from "@q/db"
import { ApiLayer, Sessions, SessionsHandlers } from "@q/server"
import { Effect, Layer, Option, type PlatformError } from "effect"
import { type HttpServerError, HttpRouter } from "effect/unstable/http"

// LAYERS — the composition root. The program does not change when a Layer here does. Storage is
// `@q/db`; the agent is picked here.

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
