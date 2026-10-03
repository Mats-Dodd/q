import { BunHttpServer } from "@effect/platform-bun"
import { ConfigProvider, Effect, Layer } from "effect"
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http"
import { ApiClient } from "../../src/client/ApiClient.ts"
import { ApiLive } from "../../src/http/Http.ts"
import { AppTest } from "./AppTest.ts"

/** The production HTTP app on a real Bun server, bound to a random port. */
const Server = HttpRouter.serve(ApiLive, { disableListenLog: true, disableLogger: true }).pipe(
  Layer.provideMerge(AppTest),
  Layer.provideMerge(BunHttpServer.layerTest)
)

/** Points the client at wherever the test server actually bound. */
const ClientConfig = Layer.unwrap(
  HttpServer.addressFormattedWith((url) =>
    Effect.succeed(ConfigProvider.layer(ConfigProvider.fromUnknown({ Q_SERVER_URL: url })))
  )
)

/**
 * Real server + real typed client over real HTTP. Also exposes the raw
 * `HttpClient` (pre-pointed at the server) for requests the typed client
 * would refuse to send, and the server's `SqlClient`.
 */
export const ServerTest = ApiClient.layer.pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(ClientConfig),
  Layer.provideMerge(Server)
)
