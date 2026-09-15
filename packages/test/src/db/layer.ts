import { BunCrypto } from "@effect/platform-bun"
import { makeSqliteClientLayer, MigrationsLayer } from "@q/db/database"
import { Layer } from "effect"

/** The real SQLite client on a throwaway in-memory database, with the schema in place. One per Layer build. */
export const DatabaseLayerTest = Layer.provideMerge(MigrationsLayer, makeSqliteClientLayer(":memory:"))

/** What the core services need under `DatabaseLayerTest`: ids come from the platform's crypto. */
export const CryptoLayerTest = BunCrypto.layer
