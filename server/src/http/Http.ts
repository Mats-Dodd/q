import { Effect, Layer } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"
import { HttpApiBuilder, HttpApiScalar } from "effect/http-api"
import { Api } from "../api/Api.ts"
import { ApiErrorsLive } from "./ApiErrorsLive.ts"
import { SessionsHttp } from "./SessionsHttp.ts"
import { SessionStreamHttp } from "./SessionStreamHttp.ts"
import { SystemHttp } from "./SystemHttp.ts"
import { MessagesHttp } from "./MessagesHttp.ts"

/** Server-Sent Events must not be cached or buffered by proxies. */
const SseNoCache = HttpRouter.middleware(
  (effect) =>
    Effect.map(effect, (response) =>
      response.body._tag === "Stream" && response.body.contentType === "text/event-stream"
        ? HttpServerResponse.setHeader(response, "cache-control", "no-cache")
        : response),
  { global: true }
)

/**
 * All HTTP routes: the API, `/openapi.json` and the Scalar reference at `/docs`.
 * Platform-agnostic; served by `HttpRouter.serve` on Bun and by
 * `HttpRouter.toWebHandler` on Workers.
 */
export const ApiLive = Layer.mergeAll(
  HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" }),
  HttpApiScalar.layer(Api, { path: "/docs" }),
  SseNoCache
).pipe(
  Layer.provide([SystemHttp, SessionsHttp, SessionStreamHttp, MessagesHttp]),
  Layer.provide(ApiErrorsLive)
)
