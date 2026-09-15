import { Api } from "@q/api-definition/api"
import { Context, Layer } from "effect"
import type { HttpClient } from "effect/unstable/http"
import { HttpApiClient, HttpApiTest } from "effect/unstable/httpapi"

// API CLIENT — the typed client generated from `Api`. Two places a server can be: across a socket, or in this process.

type ApiClientInterface = HttpApiClient.ForApi<typeof Api>

export class ApiClient extends Context.Service<ApiClient, ApiClientInterface>()("@q/client/transport/api-client/ApiClient") {
  /** Over HTTP, at `baseUrl`. */
  static readonly layerHttp = (baseUrl: string): Layer.Layer<ApiClient, never, HttpClient.HttpClient> =>
    Layer.effect(ApiClient, HttpApiClient.make(Api, { baseUrl }))

  /**
   * In the same process, over the server's handlers: the same encoding and routing as HTTP,
   * without a socket. The handlers must outlive this Layer.
   */
  static readonly layerLocal = Layer.effect(ApiClient, HttpApiTest.groups(Api, ["sessions"]))
}
