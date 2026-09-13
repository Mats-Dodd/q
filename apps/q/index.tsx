import { BunRuntime, BunServices } from "@effect/platform-bun"
import { render } from "@opentui/solid"
import { Resume, SessionId, TranscriptRepository } from "@q/core"
import { App } from "@q/tui"
import { Console, DateTime, Effect, Option } from "effect"
import { Command, Flag } from "effect/unstable/cli"

import { AppLayer, DbPath, type Launch, Storage } from "./layer"

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
        onSome: (id) => Resume.Session({ id: SessionId.make(id) }),
        onNone: () => (flags.continue ? Resume.Latest() : Resume.New()),
      })
      const launch: Launch = { db: flags.db, cwd: process.cwd(), resume }
      // OpenTUI owns the process from here. The runtime Scope, and with it the database, closes when the screen does.
      render(() => <App layer={AppLayer(launch)} />)
    }),
  ),
  Command.withDescription("A terminal coding agent."),
)

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

const cli = q.pipe(Command.withSubcommands([sessions]))

Command.run(cli, { version }).pipe(Effect.provide(BunServices.layer), BunRuntime.runMain())
