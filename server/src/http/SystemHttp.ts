import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../api/Api.ts"
import { Health } from "../api/SystemApi.ts"

export const SystemHttp = HttpApiBuilder.group(
  Api,
  "system",
  (handlers) => handlers.handle("health", () => Effect.succeed(Health.make({ status: "ok" })))
)
