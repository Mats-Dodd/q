import { Session, type SessionId } from "@q/domain/session/model"
import { type Cause, Context, Effect, Layer, Schema } from "effect"
import { SqlClient, type SqlError, SqlModel, SqlSchema } from "effect/unstable/sql"

// Rows are this module's own writes. A row that does not decode is a bug, not an error: `SchemaError` dies here.

interface SessionRepositoryInterface {
  readonly insert: (data: typeof Session.insert.Type) => Effect.Effect<Session, SqlError.SqlError>
  readonly findById: (id: SessionId) => Effect.Effect<Session, Cause.NoSuchElementError | SqlError.SqlError>
  /** Sessions started in `cwd`, newest first. */
  readonly findByCwd: (cwd: string) => Effect.Effect<ReadonlyArray<Session>, SqlError.SqlError>
}

export class SessionRepository extends Context.Service<SessionRepository, SessionRepositoryInterface>()(
  "@q/core/session/session-repository/SessionRepository",
) {
  static readonly layer = Layer.effect(
    SessionRepository,
    Effect.gen(function* layer() {
      const sql = yield* SqlClient.SqlClient
      const base = yield* SqlModel.makeRepository(Session, {
        tableName: "session",
        idColumn: "id",
        spanPrefix: "SessionRepository",
      })

      const findByCwdQuery = SqlSchema.findAll({
        Request: Schema.String,
        Result: Session,
        execute: (cwd) => sql`SELECT * FROM session WHERE cwd = ${cwd} ORDER BY created_at DESC, rowid DESC`,
      })

      const insert = Effect.fn("SessionRepository.insert")(
        (data: typeof Session.insert.Type) => base.insert(data),
        Effect.catchTag("SchemaError", Effect.die),
      )

      const findById = Effect.fn("SessionRepository.findById")(
        (id: SessionId) => base.findById(id),
        Effect.catchTag("SchemaError", Effect.die),
      )

      const findByCwd = Effect.fn("SessionRepository.findByCwd")(
        (cwd: string) => findByCwdQuery(cwd),
        Effect.catchTag("SchemaError", Effect.die),
      )

      return SessionRepository.of({ insert, findById, findByCwd })
    }),
  )
}
