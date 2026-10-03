import { BunServices } from "@effect/platform-bun"
import { Layer } from "effect"
import { AppLive } from "../../src/AppLive.ts"
import * as Database from "../../src/db/Database.ts"
import { ServerConfig } from "../../src/ServerConfig.ts"
import { SessionRepo } from "../../src/services/SessionRepo.ts"
import { TestConfig } from "./TestConfig.ts"

const Platform = Layer.mergeAll(TestConfig, BunServices.layer)

/**
 * Production application services against a fresh in-memory database. Also
 * exposes that database's `SqlClient`, so tests can cause real infrastructure
 * failures (no mocks). Layers are memoized, so it is the same database.
 */
export const AppTest = Layer.merge(AppLive, Database.layer).pipe(
  Layer.provide(ServerConfig.layer),
  Layer.provide(Platform)
)

/** Production repository against a fresh in-memory database. */
export const RepoTest = SessionRepo.layer.pipe(
  Layer.provideMerge(Database.layer),
  Layer.provide(ServerConfig.layer),
  Layer.provide(Platform)
)
