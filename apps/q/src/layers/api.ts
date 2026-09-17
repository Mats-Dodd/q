import { Api } from "@q/api-definition/api"
import { Layer } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"

import { SessionsGroupLayer } from "q/api/sessions/sessions-group-layer"
import { CoreServicesLayer } from "./infra"

/** Every group's handlers, over the core services. What both a socket and an in-process client sit on. */
export const ApiHandlersLayer = SessionsGroupLayer.pipe(Layer.provide(CoreServicesLayer))

/** The whole API on a router, with its OpenAPI document at `/openapi.json`. Needs the group handlers. */
export const ApiRoutesLayer = HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" })
