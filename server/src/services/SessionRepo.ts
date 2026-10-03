import { Context, Effect, Layer, Option, Schema } from "effect"
import { SqlClient, type SqlError, SqlModel, SqlSchema } from "effect/sql"
import { Session, SessionId } from "../domain/Session.ts"

/**
 * Persistence for sessions.
 *
 * - Every write is a single statement, so there is no read-then-write window:
 *   `update` and `delete` report a missing row through their result.
 * - Database failures are the driver's typed `SqlError` (with a classified
 *   `reason` and `isRetryable`). Rows that fail to decode are corrupt data or a
 *   bug, so they are defects.
 */
export interface SessionRepoShape {
  readonly insert: (session: typeof Session.insert.Type) => Effect.Effect<Session, SqlError.SqlError>
  /** `None` when no session has that id. */
  readonly update: (session: typeof Session.update.Type) => Effect.Effect<Option.Option<Session>, SqlError.SqlError>
  readonly findById: (id: SessionId) => Effect.Effect<Option.Option<Session>, SqlError.SqlError>
  readonly findAll: Effect.Effect<ReadonlyArray<Session>, SqlError.SqlError>
  /** `false` when no session had that id. */
  readonly delete: (id: SessionId) => Effect.Effect<boolean, SqlError.SqlError>
}

export class SessionRepo extends Context.Service<SessionRepo, SessionRepoShape>()("@q/server/services/SessionRepo", {
  make: Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const repo = yield* SqlModel.makeRepository(Session, {
      tableName: "sessions",
      spanPrefix: "SessionRepo",
      idColumn: "id"
    })

    const findAll = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Session,
      execute: () => sql`SELECT * FROM sessions ORDER BY updated_at DESC, id DESC`
    })

    const update = SqlSchema.findOneOption({
      Request: Session.update,
      Result: Session,
      execute: (row) => sql`UPDATE sessions SET ${sql.update(row, ["id"])} WHERE id = ${row.id} RETURNING *`
    })

    const remove = SqlSchema.findOneOption({
      Request: SessionId,
      Result: Schema.Struct({ id: SessionId }),
      execute: (id) => sql`DELETE FROM sessions WHERE id = ${id} RETURNING id`
    })

    return {
      insert: (session) => repo.insert(session).pipe(Effect.catchTag("SchemaError", Effect.die)),
      update: Effect.fn("SessionRepo.update")((session) =>
        update(session).pipe(Effect.catchTag("SchemaError", Effect.die))
      ),
      findById: (id) =>
        repo.findById(id).pipe(Effect.catchNoSuchElement, Effect.catchTag("SchemaError", Effect.die)),
      findAll: findAll(undefined).pipe(Effect.catchTag("SchemaError", Effect.die), Effect.withSpan("SessionRepo.findAll")),
      delete: Effect.fn("SessionRepo.delete")((id) =>
        remove(id).pipe(Effect.map(Option.isSome), Effect.catchTag("SchemaError", Effect.die))
      )
    } satisfies SessionRepoShape
  })
}) {
  static readonly layer = Layer.effect(SessionRepo, SessionRepo.make)
}
