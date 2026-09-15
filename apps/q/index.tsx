import { BunRuntime, BunServices } from "@effect/platform-bun"
import { render } from "@opentui/solid"
import { Resume, SessionId, TranscriptRepository } from "@q/core"
import { DbPath, Storage } from "@q/db"
import { App } from "@q/tui"
import { Console, DateTime, Effect, Layer, Option } from "effect"
import { Command, Flag } from "effect/unstable/cli"

import { type Launch, Serve, TransportLayer } from "./layer"

// ENTRY — parse the command line, pick the session, render. The only place that knows about flags.

const version = "0.0.0"

/** `--db` is shared: subcommands read it by yielding `q`. */
const q = Command.make("q", {
  continue: Flag.Boolean("continue").pipe(
    Flag.withAlias("c"),
    Flag.withDefault(false),
    Flag.withDescription("Resume the latest session started in this directory."),
  ),
  resume: Flag.String("resume").pipe(
    Flag.withAlias("r"),
    Flag.optional,
    Flag.withDescription("Resume the session with this id. See `q sessions`."),
  ),
  server: Flag.String("server").pipe(
    Flag.withAlias("s"),
    Flag.optional,
    Flag.withDescription("Talk to a running `q serve` at this URL instead of running the server in this process."),
  ),
}).pipe(
  Command.withSharedFlags({
    db: Flag.Path("db").pipe(
      Flag.withFallbackConfig(DbPath),
      Flag.withDescription("SQLite file that holds every session. Also read from Q_DB; defaults under XDG_DATA_HOME."),
    ),
  }),
  Command.withHandler((flags) =>
    Effect.sync(() => {
      const resume: Resume = Option.match(flags.resume, {
        onSome: (id) => Resume.cases.Session.make({ id: SessionId.make(id) }),
        onNone: () => (flags.continue ? Resume.cases.Latest.make({}) : Resume.cases.New.make({})),
      })
      const launch: Launch = { db: flags.db, cwd: process.cwd(), resume, server: flags.server }
      // OpenTUI owns the process from here. The runtime Scope, and with it the embedded server or the
      // HTTP client, closes when the screen does.
      render(() => <App layer={TransportLayer(launch)} />)
    }),
  ),
  Command.withDescription("A terminal coding agent."),
)

const serve = Command.make(
  "serve",
  {
    port: Flag.Int("port").pipe(
      Flag.withAlias("p"),
      Flag.withDefault(7331),
      Flag.withDescription("Port to listen on, on 127.0.0.1."),
    ),
  },
  ({ port }) =>
    Effect.gen(function* () {
      const { db } = yield* q
      yield* Console.log(`q serving http://127.0.0.1:${port} over ${db}`)
      yield* Layer.launch(Serve(db, port))
    }),
).pipe(Command.withDescription("Run the server alone. Clients connect with `q --server URL`."))

const listSessions = Effect.gen(function* () {
  const cwd = process.cwd()
  const all = yield* (yield* TranscriptRepository).sessions(cwd)
  if (all.length === 0) {
    yield* Console.log(`no sessions in ${cwd}`)
    return
  }
  for (const session of all) {
    yield* Console.log(`${session.id}  ${DateTime.formatIso(session.createdAt)}`)
  }
})

const sessions = Command.make("sessions", {}, () =>
  Effect.gen(function* () {
    const { db } = yield* q
    yield* listSessions.pipe(Effect.provide(Storage(db)))
  }),
).pipe(Command.withDescription("List the sessions started in this directory, newest first."))

const cli = q.pipe(Command.withSubcommands([serve, sessions]))

Command.run(cli, { version }).pipe(Effect.provide(BunServices.layer), BunRuntime.runMain())
