import { AgentConfig } from "@q/config/agent-config"
import { DatabaseConfig } from "@q/config/database-config"
import { ServerConfig } from "@q/config/server-config"
import { Console, Effect, Layer } from "effect"
import { Command, Flag } from "effect/unstable/cli"

import { ServeLayer } from "q/layers/app"
import { chatCommand } from "./chat"

export const serveCommand = Command.make(
  "serve",
  {
    port: Flag.Int("port").pipe(
      Flag.withAlias("p"),
      Flag.withFallbackConfig(ServerConfig.port),
      Flag.withDescription("Port to listen on. Also read from Q_PORT."),
    ),
  },
  Effect.fn("serveCommand")(function* serve({ port }) {
    const { db } = yield* chatCommand
    const host = yield* ServerConfig.host
    yield* Console.log(`q serving http://${host}:${port} over ${db}`)
    const config = Layer.mergeAll(
      Layer.succeed(DatabaseConfig, { path: db }),
      Layer.succeed(ServerConfig, { host, port }),
      AgentConfig.layer,
    )
    return yield* Layer.launch(ServeLayer.pipe(Layer.provide(config)))
  }),
).pipe(Command.withDescription("Run the server alone. Clients connect with `q --server URL`."))
