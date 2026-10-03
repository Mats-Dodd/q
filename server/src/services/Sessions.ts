import { Context, Effect, Layer } from "effect"
import type { SqlError } from "effect/sql"
import { Session, type SessionId, SessionNotFound } from "../domain/Session.ts"
import { SessionRepo } from "./SessionRepo.ts"

/** Session lifecycle. The only place session rules live; HTTP handlers just delegate here. */
export interface SessionsShape {
  readonly create: (input: typeof Session.jsonCreate.Type) => Effect.Effect<Session, SqlError.SqlError>
  readonly list: Effect.Effect<ReadonlyArray<Session>, SqlError.SqlError>
  readonly get: (id: SessionId) => Effect.Effect<Session, SessionNotFound | SqlError.SqlError>
  readonly update: (
    id: SessionId,
    input: typeof Session.jsonUpdate.Type
  ) => Effect.Effect<Session, SessionNotFound | SqlError.SqlError>
  readonly remove: (id: SessionId) => Effect.Effect<void, SessionNotFound | SqlError.SqlError>
}

export class Sessions extends Context.Service<Sessions, SessionsShape>()("@q/server/services/Sessions", {
  make: Effect.gen(function*() {
    const repo = yield* SessionRepo

    const create = Effect.fn("Sessions.create")(function*(input: typeof Session.jsonCreate.Type) {
      const row = yield* Effect.orDie(Session.insert.makeEffect({ title: input.title }))
      const session = yield* repo.insert(row)
      yield* Effect.annotateCurrentSpan({ sessionId: session.id })
      return session
    })

    const get = Effect.fn("Sessions.get")(function*(id: SessionId) {
      yield* Effect.annotateCurrentSpan({ sessionId: id })
      const session = yield* repo.findById(id)
      return yield* Effect.fromOption(session, () => SessionNotFound.make({ id }))
    })

    const update = Effect.fn("Sessions.update")(function*(id: SessionId, input: typeof Session.jsonUpdate.Type) {
      yield* Effect.annotateCurrentSpan({ sessionId: id })
      const row = yield* Effect.orDie(Session.update.makeEffect({ id, title: input.title }))
      const updated = yield* repo.update(row)
      return yield* Effect.fromOption(updated, () => SessionNotFound.make({ id }))
    })

    const remove = Effect.fn("Sessions.remove")(function*(id: SessionId) {
      yield* Effect.annotateCurrentSpan({ sessionId: id })
      yield* repo.delete(id).pipe(Effect.filterOrFail((removed) => removed, () => SessionNotFound.make({ id })))
    })

    return {
      create,
      list: repo.findAll.pipe(Effect.withSpan("Sessions.list")),
      get,
      update,
      remove
    } satisfies SessionsShape
  })
}) {
  static readonly layer = Layer.effect(Sessions, Sessions.make)
}
