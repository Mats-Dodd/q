import { BunHttpClient, BunHttpServer, BunServices } from "@effect/platform-bun"
import { ApiClient } from "@q/client/transport/api-client"
import { openSession, Transport } from "@q/client/transport/transport-service"
import { DatabaseLayer } from "@q/db/database"
import type { Resume } from "@q/domain/session/model"
import { Effect, Layer, Option } from "effect"
import { HttpRouter } from "effect/unstable/http"

import { ApiHandlersLayer, ApiRoutesLayer } from "./api"
import { HttpServerLayer } from "./infra"

// APP — the composition roots. The program does not change when a Layer here does.

/** `q serve`: the API on a socket, over the configured database. */
export const ServeLayer = HttpRouter.serve(ApiRoutesLayer).pipe(
  Layer.provide([ApiHandlersLayer, HttpServerLayer]),
  Layer.provide(DatabaseLayer),
)

/** What one launch of the TUI needs to know. Parsed from the command line. */
export interface Launch {
  /** The directory `q` was started in. Sessions belong to it. */
  readonly cwd: string
  readonly resume: Resume
  /** A server to talk to instead of running one here. */
  readonly server: Option.Option<string>
}

/** Open the session first, then bind the transport to it. An unknown id fails the Layer, which the screen shows as a crash. */
const TransportForLaunch = (launch: Launch) =>
  Layer.unwrap(Effect.map(openSession(launch.cwd, launch.resume), (session) => Transport.layer(session.id)))

/**
 * The TUI's transport for this launch. With `--server`, over HTTP; otherwise the server runs in this
 * process and the client reaches it through its handlers, with no socket.
 */
export const TransportLayer = (launch: Launch) =>
  Option.match(launch.server, {
    onSome: (url) => TransportForLaunch(launch).pipe(Layer.provide(ApiClient.layerHttp(url)), Layer.provide(BunHttpClient.layer)),
    onNone: () =>
      TransportForLaunch(launch).pipe(
        Layer.provide(ApiClient.layerLocal),
        Layer.provide([ApiHandlersLayer, BunHttpServer.layerHttpServices]),
        Layer.provide(DatabaseLayer),
        Layer.provide(BunServices.layer),
      ),
  })
