import { Config, Context, Layer, type Option } from "effect"

/**
 * Every configuration key the server reads lives in this module. Tests supply
 * values through a `ConfigProvider` (see `test/support/TestConfig.ts`).
 */
export interface ServerConfigShape {
  /** `Q_DB_PATH`: SQLite file. `:memory:` gives a throwaway database. */
  readonly dbPath: string
  /** `Q_LOG_FILE`: write JSON logs here instead of the console (set by the TUI when it spawns us). */
  readonly logFile: Option.Option<string>
  /** `Q_DEVTOOLS`: stream spans to the Effect DevTools. */
  readonly devtools: boolean
}

export class ServerConfig extends Context.Service<ServerConfig, ServerConfigShape>()("@q/server/ServerConfig", {
  make: Config.all({
    dbPath: Config.String("Q_DB_PATH").pipe(Config.withDefault(".data/q.db")),
    logFile: Config.option(Config.String("Q_LOG_FILE")),
    devtools: Config.Boolean("Q_DEVTOOLS").pipe(Config.withDefault(false))
  })
}) {
  static readonly layer = Layer.effect(ServerConfig, ServerConfig.make)
}

/** `Q_PORT`: fallback for `q-server serve --port`. */
export const port = Config.Port("Q_PORT")

/** `Q_HOST`: fallback for `q-server serve --host`. */
export const host = Config.String("Q_HOST")
