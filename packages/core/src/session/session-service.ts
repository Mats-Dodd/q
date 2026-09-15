import { PersistenceError } from "@q/domain/persistence-error"
import { SessionNotFoundError } from "@q/domain/session/errors"
import { type Resume, ResumeSchema, Session, SessionId } from "@q/domain/session/model"
import { Context, Crypto, Effect, Layer } from "effect"
import type { SqlError } from "effect/unstable/sql"

import { SessionRepository } from "./session-repository"

// SESSION SERVICE — the public face of the session module. Infrastructure failures leave here as `PersistenceError`.

interface SessionServiceInterface {
  /** Which session `resume` means in `cwd`, creating one when asked. Only `Resume.Session` can miss. */
  readonly resolve: (resume: Resume, cwd: string) => Effect.Effect<Session, SessionNotFoundError | PersistenceError>
  readonly findById: (id: SessionId) => Effect.Effect<Session, SessionNotFoundError | PersistenceError>
  /** Sessions started in `cwd`, newest first. */
  readonly list: (cwd: string) => Effect.Effect<ReadonlyArray<Session>, PersistenceError>
}

export class SessionService extends Context.Service<SessionService, SessionServiceInterface>()(
  "@q/core/session/session-service/SessionService",
) {
  static readonly layer = Layer.effect(
    SessionService,
    Effect.gen(function* layer() {
      const repository = yield* SessionRepository
      const crypto = yield* Crypto.Crypto

      const create = Effect.fn("SessionService.create")(
        function* create(cwd: string) {
          const id = SessionId.make(yield* crypto.randomUUIDv4)
          return yield* repository.insert(Session.insert.make({ id, cwd }))
        },
        Effect.catchTag("PlatformError", Effect.die),
      )

      const latest = Effect.fn("SessionService.latest")(function* latest(cwd: string) {
        const sessions = yield* repository.findByCwd(cwd)
        return sessions.length === 0 ? yield* create(cwd) : sessions[0]!
      })

      const find = Effect.fn("SessionService.find")(function* find(id: SessionId) {
        return yield* repository
          .findById(id)
          .pipe(Effect.catchTag("NoSuchElementError", () => Effect.fail(new SessionNotFoundError({ sessionId: id }))))
      })

      const findById = Effect.fn("SessionService.findById")((id: SessionId) => find(id), Effect.catchTag("SqlError", toPersistenceError))

      const resolve = Effect.fn("SessionService.resolve")(
        (resume: Resume, cwd: string) =>
          ResumeSchema.match(resume, {
            New: () => create(cwd),
            Latest: () => latest(cwd),
            Session: ({ id }) => find(id),
          }),
        Effect.catchTag("SqlError", toPersistenceError),
      )

      const list = Effect.fn("SessionService.list")(
        (cwd: string) => repository.findByCwd(cwd),
        Effect.catchTag("SqlError", toPersistenceError),
      )

      return SessionService.of({ resolve, findById, list })
    }),
  )

  static readonly live = SessionService.layer.pipe(Layer.provide(SessionRepository.layer))
}

const toPersistenceError = (cause: SqlError.SqlError) => Effect.fail(new PersistenceError({ cause, message: cause.message }))
