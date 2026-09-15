import { DatabaseConfig } from "@q/config/database-config"
import { SessionService } from "@q/core/session/session-service"
import { DatabaseLayer } from "@q/db/database"
import { Console, DateTime, Effect, Layer } from "effect"
import { Command } from "effect/unstable/cli"

import { chatCommand } from "../chat"

const listSessions = Effect.fn("listSessions")(function* listSessions(cwd: string) {
  const sessions = yield* SessionService
  const all = yield* sessions.list(cwd)
  if (all.length === 0) {
    yield* Console.log(`no sessions in ${cwd}`)
    return
  }
  for (const session of all) {
    yield* Console.log(`${session.id}  ${DateTime.formatIso(session.createdAt)}`)
  }
})

/** `SessionService` over the database at `path`. The flag is only known inside the handler, so the layer is built here. */
const sessionsAt = (path: string) =>
  SessionService.live.pipe(Layer.provide(DatabaseLayer), Layer.provide(Layer.succeed(DatabaseConfig, { path })))

export const listCommand = Command.make("list", {}, () =>
  Effect.gen(function* list() {
    const { db } = yield* chatCommand
    const services = yield* Layer.build(sessionsAt(db))
    yield* Effect.provideContext(listSessions(process.cwd()), services)
  }).pipe(Effect.scoped),
).pipe(Command.withDescription("List the sessions started in this directory, newest first."))
