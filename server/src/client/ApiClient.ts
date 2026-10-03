import { Config, Context, Effect, Layer } from "effect"
import { HttpApiClient } from "effect/http-api"
import { Api } from "../api/Api.ts"

/** Fully typed client for the server, derived from the `Api` contract. */
export type ApiClientShape = HttpApiClient.ForApi<typeof Api>

export class ApiClient extends Context.Service<ApiClient, ApiClientShape>()("@q/server/client/ApiClient") {
  static readonly layer = Layer.effect(
    ApiClient,
    Effect.gen(function*() {
      const baseUrl = yield* Config.URL("Q_SERVER_URL").pipe(Config.withDefault(new URL("http://127.0.0.1:7777")))
      return yield* HttpApiClient.make(Api, { baseUrl })
    })
  )
}
