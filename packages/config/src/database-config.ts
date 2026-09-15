import { Config, Context, Layer, Option } from "effect"

interface DatabaseConfigInterface {
  /** Path of the SQLite file. `:memory:` for a throwaway database. */
  readonly path: string
}

export class DatabaseConfig extends Context.Service<DatabaseConfig, DatabaseConfigInterface>()("@q/config/database-config/DatabaseConfig") {
  /** `$Q_DB`, else `$XDG_DATA_HOME/q/q.db`, else `~/.local/share/q/q.db`. */
  static readonly path: Config.Config<string> = Config.String("Q_DB").pipe(
    Config.orElse(() =>
      Config.all([Config.option(Config.String("XDG_DATA_HOME")), Config.String("HOME")]).pipe(
        Config.map(([xdg, home]) => `${Option.getOrElse(xdg, () => `${home}/.local/share`)}/q/q.db`),
      ),
    ),
  )

  static readonly layer = Layer.effect(
    DatabaseConfig,
    Config.map(DatabaseConfig.path, (path) => DatabaseConfig.of({ path })),
  )
}
