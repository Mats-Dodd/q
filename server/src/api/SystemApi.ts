import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"

export class Health extends Schema.Class<Health>("Health")({
  status: Schema.Literal("ok")
}) {}

export class SystemApi extends HttpApiGroup.make("system")
  .add(HttpApiEndpoint.get("health", "/health", { success: Health }))
{}
