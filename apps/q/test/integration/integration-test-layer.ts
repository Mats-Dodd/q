import { BunHttpServer } from "@effect/platform-bun"
import { ApiClient } from "@q/client/transport/api-client"
import { AgentService } from "@q/core/agent/agent-service"
import { SessionRuntimeService } from "@q/core/session-runtime/session-runtime-service"
import { SessionService } from "@q/core/session/session-service"
import { TranscriptService } from "@q/core/transcript/transcript-service"
import { CryptoLayerTest, DatabaseLayerTest } from "@q/test/db/layer"
import { HttpPlatformLayerTest } from "@q/test/http/platform-layer"
import { Context, Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"

import { SessionsGroupLayer } from "q/api/sessions/sessions-group-layer"
import { ApiRoutesLayer } from "q/layers/api"

// The real handlers over the real services on a throwaway database, with the agent the test picks.
// Production binds `AgentService.live` (from config); here the agent is a parameter.

/** The `sessions` handlers over fresh services and the given agent. */
const makeHandlersLayerTest = (agent: Layer.Layer<AgentService>) =>
  SessionsGroupLayer.pipe(
    Layer.provide(SessionRuntimeService.layer.pipe(Layer.provideMerge(Layer.mergeAll(SessionService.live, TranscriptService.live, agent)))),
    Layer.provide([DatabaseLayerTest, CryptoLayerTest]),
  )

/** An in-process `ApiClient` over `makeHandlersLayerTest(agent)`. The server, and its database, live in the caller's Scope. */
export const makeApiClientIntegration = (agent: Layer.Layer<AgentService>) =>
  Effect.map(Layer.build(ApiClient.layerLocal.pipe(Layer.provide([makeHandlersLayerTest(agent), HttpPlatformLayerTest]))), (context) =>
    Context.get(context, ApiClient),
  )

/** The API on a real socket, on an ephemeral port, with the echo agent. */
export const ServerLayerIntegration = HttpRouter.serve(ApiRoutesLayer, { disableLogger: true }).pipe(
  Layer.provide(makeHandlersLayerTest(AgentService.layerEcho("1 millis"))),
  Layer.provideMerge(BunHttpServer.layerTest),
)
