import { BunServices } from "@effect/platform-bun"
import { Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { AppLive } from "../../src/AppLive.ts"
import * as Database from "../../src/db/Database.ts"
import { ServerConfig } from "../../src/ServerConfig.ts"
import { SessionRepo } from "../../src/services/SessionRepo.ts"
import { testConfig } from "./TestConfig.ts"

const platform = (overrides?: Readonly<Record<string, string>>) =>
  Layer.mergeAll(testConfig(overrides), BunServices.layer)

/**
 * Production application services, by default against a fresh in-memory
 * database. Also exposes that database's `SqlClient`, so tests can cause real
 * infrastructure failures (no mocks), the platform services, and the
 * `FakeAnthropic` behind the model. (Its `HttpClient` is not exposed: tests
 * get one pointed at the server from `ServerTest`.) Layers are memoized, so it
 * is the same database.
 */
export const appTest = (overrides?: Readonly<Record<string, string>>) =>
  Layer.merge(AppLive, Database.layer).pipe(
    Layer.provide([ServerConfig.layer, FetchHttpClient.layer]),
    Layer.provideMerge(platform(overrides))
  )

export const AppTest = appTest()

/** Production repository against a fresh in-memory database. */
export const RepoTest = SessionRepo.layer.pipe(
  Layer.provideMerge(Database.layer),
  Layer.provide(ServerConfig.layer),
  Layer.provide(platform())
)
