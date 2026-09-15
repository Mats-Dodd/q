import { Config, Context, Effect, Layer } from "effect"

interface ServerConfigInterface {
  readonly host: string
  readonly port: number
}

export class ServerConfig extends Context.Service<ServerConfig, ServerConfigInterface>()("@q/config/server-config/ServerConfig") {
  static readonly host: Config.Config<string> = Config.String("Q_HOST").pipe(Config.withDefault("127.0.0.1"))
  static readonly port: Config.Config<number> = Config.Port("Q_PORT").pipe(Config.withDefault(7331))

  static readonly layer = Layer.effect(
    ServerConfig,
    Effect.gen(function* layer() {
      const host = yield* ServerConfig.host
      const port = yield* ServerConfig.port
      return ServerConfig.of({ host, port })
    }),
  )
}
