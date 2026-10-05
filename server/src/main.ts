import { BunHttpServer, BunRuntime, BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { Command, Flag } from "effect/cli"
import { FetchHttpClient, HttpRouter } from "effect/http"
import pkg from "../package.json" with { type: "json" }
import { AppLive } from "./AppLive.ts"
import { ApiLive } from "./http/Http.ts"
import * as Observability from "./observability/Observability.ts"
import * as ServerConfig from "./ServerConfig.ts"

const portFlag = Flag.Int("port").pipe(
  Flag.withDescription("Port to listen on"),
  Flag.withFallbackConfig(ServerConfig.port),
  Flag.withDefault(7777)
)

const hostFlag = Flag.String("host").pipe(
  Flag.withDescription("Interface to bind. Loopback by default: the bundled server must not be reachable from the network"),
  Flag.withFallbackConfig(ServerConfig.host),
  Flag.withDefault("127.0.0.1")
)

const serve = Command.make("serve", { port: portFlag, host: hostFlag }, ({ host, port }) =>
  HttpRouter.serve(ApiLive).pipe(
    Layer.provide(AppLive),
    Layer.provide(BunHttpServer.layer({ port, hostname: host })),
    Layer.launch
  )).pipe(Command.withDescription("Run the q server"))

const cli = Command.make("q-server").pipe(
  Command.withDescription("The q coding agent server"),
  Command.withSubcommands([serve])
)

const MainLive = Observability.layer.pipe(
  Layer.provide(ServerConfig.ServerConfig.layer),
  Layer.provideMerge(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer))
)

Command.run(cli, { version: pkg.version }).pipe(
  // oxlint-disable-next-line effecttsgo/strict-effect-provide -- application entry point
  Effect.provide(MainLive),
  BunRuntime.runMain
)
