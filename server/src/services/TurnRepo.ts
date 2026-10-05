import { Context, DateTime, Effect, Layer, type Option, Schema } from "effect"
import { SqlClient, type SqlError, SqlModel, SqlSchema } from "effect/sql"
import { Turn, TurnId } from "../domain/Turn.ts"

/**
 * Persistence for turns. At most one turn per session is `running`: a unique
 * index enforces it, so starting a second one fails with a `UniqueViolation`.
 */
export interface TurnRepoShape {
  /** `None` when a turn with that id already exists (a retried send). */
  readonly insert: (turn: typeof Turn.insert.Type) => Effect.Effect<Option.Option<Turn>, SqlError.SqlError>
  readonly findById: (id: TurnId) => Effect.Effect<Option.Option<Turn>, SqlError.SqlError>
  /** Records how a running turn ended; `None` when it was not running (or no longer exists). */
  readonly finish: (turn: typeof Turn.update.Type) => Effect.Effect<Option.Option<Turn>, SqlError.SqlError>
  /** Marks every running turn failed (they were cut off by a restart), returning them. */
  readonly failRunning: Effect.Effect<ReadonlyArray<Turn>, SqlError.SqlError>
}

export class TurnRepo extends Context.Service<TurnRepo, TurnRepoShape>()("@q/server/services/TurnRepo", {
  make: Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const repo = yield* SqlModel.makeRepository(Turn, {
      tableName: "turns",
      spanPrefix: "TurnRepo",
      idColumn: "id"
    })

    const insert = SqlSchema.findOneOption({
      Request: Turn.insert,
      Result: Turn,
      execute: (row) => sql`INSERT INTO turns ${sql.insert(row)} ON CONFLICT (id) DO NOTHING RETURNING *`
    })

    const finish = SqlSchema.findOneOption({
      Request: Turn.update,
      Result: Turn,
      execute: (row) =>
        sql`UPDATE turns SET ${sql.update(row, ["id"])} WHERE id = ${row.id} AND status = 'running' RETURNING *`
    })

    const failRunning = SqlSchema.findAll({
      Request: Schema.Struct({ updatedAt: Schema.DateTimeUtcFromString }),
      Result: Turn,
      execute: ({ updatedAt }) =>
        sql`UPDATE turns SET status = 'failed', updated_at = ${updatedAt} WHERE status = 'running' RETURNING *`
    })

    return {
      insert: Effect.fn("TurnRepo.insert")((turn) => insert(turn).pipe(Effect.catchTag("SchemaError", Effect.die))),
      findById: (id) =>
        repo.findById(id).pipe(Effect.catchNoSuchElement, Effect.catchTag("SchemaError", Effect.die)),
      finish: Effect.fn("TurnRepo.finish")((turn) => finish(turn).pipe(Effect.catchTag("SchemaError", Effect.die))),
      failRunning: DateTime.now.pipe(
        Effect.flatMap((updatedAt) => failRunning({ updatedAt })),
        Effect.catchTag("SchemaError", Effect.die),
        Effect.withSpan("TurnRepo.failRunning")
      )
    } satisfies TurnRepoShape
  })
}) {
  static readonly layer = Layer.effect(TurnRepo, TurnRepo.make)
}
