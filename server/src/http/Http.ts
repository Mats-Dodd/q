import { Layer } from "effect"
import { HttpApiBuilder, HttpApiScalar } from "effect/http-api"
import { Api } from "../api/Api.ts"
import { ApiErrorsLive } from "./ApiErrorsLive.ts"
import { SessionsHttp } from "./SessionsHttp.ts"
import { SystemHttp } from "./SystemHttp.ts"

/**
 * All HTTP routes: the API, `/openapi.json` and the Scalar reference at `/docs`.
 * Platform-agnostic; served by `HttpRouter.serve` on Bun and by
 * `HttpRouter.toWebHandler` on Workers.
 */
export const ApiLive = Layer.mergeAll(
  HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" }),
  HttpApiScalar.layer(Api, { path: "/docs" })
).pipe(
  Layer.provide([SystemHttp, SessionsHttp]),
  Layer.provide(ApiErrorsLive)
)
