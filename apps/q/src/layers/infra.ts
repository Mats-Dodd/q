import { BunHttpClient, BunHttpServer } from "@effect/platform-bun"
import { ServerConfig } from "@q/config/server-config"
import { AgentService } from "@q/core/agent/agent-service"
import { SessionRuntimeService } from "@q/core/session-runtime/session-runtime-service"
import { SessionService } from "@q/core/session/session-service"
import { TranscriptService } from "@q/core/transcript/transcript-service"
import { Effect, Layer } from "effect"

// INFRA — the layers under the API: the HTTP server on its socket, and the core services over storage.

/** Bun's server on the configured host and port. */
export const HttpServerLayer = Layer.unwrap(Effect.map(ServerConfig, ({ host, port }) => BunHttpServer.layer({ port, hostname: host })))

/** Every core service the handlers reach for, over `SqlClient`, `Crypto` and `AgentConfig`. The agent reaches its provider over Bun's fetch. */
export const CoreServicesLayer = SessionRuntimeService.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(SessionService.live, TranscriptService.live, AgentService.live)),
  Layer.provide(BunHttpClient.layer),
)
