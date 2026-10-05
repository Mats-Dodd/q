import { HttpApi } from "effect/http-api"
import { ApiErrors } from "./ApiErrors.ts"
import { SessionsApi } from "./SessionsApi.ts"
import { SessionStreamApi } from "./SessionStreamApi.ts"
import { SystemApi } from "./SystemApi.ts"
import { MessagesApi } from "./MessagesApi.ts"

/**
 * The server contract. Pure description: no handlers, no runtime dependencies.
 * Shared by the server (`http/`), the typed client (`client/`) and the
 * OpenAPI / JSON Schema generators.
 */
export class Api extends HttpApi.make("q")
  .add(SystemApi, SessionsApi, SessionStreamApi, MessagesApi)
  .middleware(ApiErrors)
{}
