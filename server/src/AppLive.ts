import { Layer } from "effect"
import * as Anthropic from "./ai/Anthropic.ts"
import * as Database from "./db/Database.ts"
import { ServerConfig } from "./ServerConfig.ts"
import { AgentLoop } from "./services/AgentLoop.ts"
import { ModelLog } from "./services/ModelLog.ts"
import { SessionRepo } from "./services/SessionRepo.ts"
import { SessionRuntimes } from "./services/SessionRuntimes.ts"
import { Sessions } from "./services/Sessions.ts"
import { SessionStreams } from "./services/SessionStreams.ts"
import { StreamChunkRepo } from "./services/StreamChunkRepo.ts"
import { TurnRepo } from "./services/TurnRepo.ts"

const Persistence = Layer.mergeAll(SessionRepo.layer, StreamChunkRepo.layer, TurnRepo.layer, ModelLog.layer)

/**
 * The composition root for application services (no transport). `main.ts`,
 * the tests and future runtimes (Worker / Durable Object) all build on this.
 *
 * Requires platform services (`FileSystem`, `Path`, and an `HttpClient` for the
 * model) from the edge that runs it, and reads configuration from the ambient
 * `ConfigProvider`.
 */
export const AppLive = SessionRuntimes.layer.pipe(
  Layer.provide(AgentLoop.layer),
  Layer.provideMerge(Layer.mergeAll(Sessions.layer, SessionStreams.layer)),
  Layer.provide([Persistence, Anthropic.layer]),
  Layer.provide(Database.layer),
  Layer.provide(ServerConfig.layer)
)
