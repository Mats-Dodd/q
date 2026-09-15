import { render } from "@opentui/solid"
import { AgentConfig } from "@q/config/agent-config"
import { DatabaseConfig } from "@q/config/database-config"
import { type Resume, ResumeSchema, SessionId } from "@q/domain/session/model"
import { App } from "@q/tui/view"
import { Effect, Layer, Option } from "effect"
import { Command, Flag } from "effect/unstable/cli"

import { type Launch, TransportLayer } from "../layers/app"

// `q` — the root command: pick the session, render. Subcommands read the shared `--db` by yielding `chatCommand`.

export const chatCommand = Command.make("q", {
  continue: Flag.Boolean("continue").pipe(
    Flag.withAlias("c"),
    Flag.withDefault(false),
    Flag.withDescription("Resume the latest session started in this directory."),
  ),
  resume: Flag.String("resume").pipe(
    Flag.withAlias("r"),
    Flag.optional,
    Flag.withDescription("Resume the session with this id. See `q sessions list`."),
  ),
  server: Flag.String("server").pipe(
    Flag.withAlias("s"),
    Flag.optional,
    Flag.withDescription("Talk to a running `q serve` at this URL instead of running the server in this process."),
  ),
}).pipe(
  Command.withSharedFlags({
    db: Flag.Path("db").pipe(
      Flag.withFallbackConfig(DatabaseConfig.path),
      Flag.withDescription("SQLite file that holds every session. Also read from Q_DB; defaults under XDG_DATA_HOME."),
    ),
  }),
  Command.withHandler((flags) =>
    Effect.sync(() => {
      const resume: Resume = Option.match(flags.resume, {
        onSome: (id) => ResumeSchema.cases.Session.make({ id: SessionId.make(id) }),
        onNone: () => (flags.continue ? ResumeSchema.cases.Latest.make({}) : ResumeSchema.cases.New.make({})),
      })
      const launch: Launch = { cwd: process.cwd(), resume, server: flags.server }
      const config = Layer.mergeAll(Layer.succeed(DatabaseConfig, { path: flags.db }), AgentConfig.layer)
      // OpenTUI owns the process from here. The runtime Scope, and with it the embedded server or the
      // HTTP client, closes when the screen does.
      render(() => <App layer={TransportLayer(launch).pipe(Layer.provide(config))} />)
    }),
  ),
  Command.withDescription("A terminal coding agent."),
)
