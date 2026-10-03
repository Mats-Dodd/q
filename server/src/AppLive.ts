import { Layer } from "effect"
import * as Database from "./db/Database.ts"
import { ServerConfig } from "./ServerConfig.ts"
import { SessionRepo } from "./services/SessionRepo.ts"
import { Sessions } from "./services/Sessions.ts"

/**
 * The composition root for application services (no transport). `main.ts`,
 * the tests and future runtimes (Worker / Durable Object) all build on this.
 *
 * Requires platform services (`FileSystem`, `Path`) from the edge that runs it,
 * and reads configuration from the ambient `ConfigProvider`.
 */
export const AppLive = Sessions.layer.pipe(
  Layer.provide(SessionRepo.layer),
  Layer.provide(Database.layer),
  Layer.provide(ServerConfig.layer)
)
