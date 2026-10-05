import { Array, Context, DateTime, Effect, Layer, Option, Order, Schema } from "effect"
import { SqlClient, type SqlError, SqlSchema } from "effect/sql"
import { SessionId } from "../domain/Session.ts"
import { SessionEvent, SessionEventJson, type StoredEvent } from "../domain/SessionEvent.ts"

const StoredEventRow = Schema.Struct({ seq: Schema.Int, event: SessionEventJson })

/**
 * Persistence for session events: per session, an append-only log numbered
 * from 0 with no gaps.
 *
 * - `append` is one statement that inserts only if the log is still at the
 *   expected version (no one else appended since the writer last read it); an
 *   empty result means it was not.
 * - Rows that fail to decode are corrupt data or a bug, so they are defects.
 */
export interface SessionEventRepoShape {
  /** The stored events in order, or none if the log is not at `expected`. */
  readonly append: (
    sessionId: SessionId,
    expected: number,
    events: Array.NonEmptyReadonlyArray<SessionEvent>
  ) => Effect.Effect<ReadonlyArray<StoredEvent>, SqlError.SqlError>
  /** Every event with `seq >= from`, in order. */
  readonly readFrom: (sessionId: SessionId, from: number) => Effect.Effect<ReadonlyArray<StoredEvent>, SqlError.SqlError>
  /** The `seq` the next event will get; `None` when no session has that id. */
  readonly nextSeq: (sessionId: SessionId) => Effect.Effect<Option.Option<number>, SqlError.SqlError>
  /** Sessions with a turn that started and never ended (cut off by a restart). */
  readonly withUnfinishedTurns: Effect.Effect<ReadonlyArray<SessionId>, SqlError.SqlError>
}

export class SessionEventRepo extends Context.Service<SessionEventRepo, SessionEventRepoShape>()(
  "@q/server/services/SessionEventRepo",
  {
    make: Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient

      const append = SqlSchema.findAll({
        Request: Schema.Struct({
          sessionId: SessionId,
          expected: Schema.Int,
          events: Schema.fromJsonString(Schema.Array(Schema.toCodecJson(SessionEvent))),
          createdAt: Schema.DateTimeUtcFromString
        }),
        Result: StoredEventRow,
        execute: ({ createdAt, events, expected, sessionId }) =>
          sql`
            INSERT INTO session_events (session_id, seq, type, turn_id, event, created_at)
            SELECT ${sessionId}, ${expected} + incoming.key, json_extract(incoming.value, '$._tag'),
                   json_extract(incoming.value, '$.turnId'), incoming.value, ${createdAt}
            FROM json_each(${events}) AS incoming
            WHERE (SELECT COALESCE(MAX(seq) + 1, 0) FROM session_events WHERE session_id = ${sessionId}) = ${expected}
            ORDER BY incoming.key
            RETURNING seq, event
          `
      })

      const readFrom = SqlSchema.findAll({
        Request: Schema.Struct({ sessionId: SessionId, from: Schema.Int }),
        Result: StoredEventRow,
        execute: ({ from, sessionId }) =>
          sql`SELECT seq, event FROM session_events WHERE session_id = ${sessionId} AND seq >= ${from} ORDER BY seq`
      })

      const nextSeq = SqlSchema.findOneOption({
        Request: SessionId,
        Result: Schema.Struct({ next: Schema.Int }),
        execute: (id) =>
          sql`
            SELECT (SELECT COALESCE(MAX(seq) + 1, 0) FROM session_events WHERE session_id = sessions.id) AS next
            FROM sessions WHERE id = ${id}
          `
      })

      const withUnfinishedTurns = SqlSchema.findAll({
        Request: Schema.Void,
        Result: Schema.Struct({ sessionId: SessionId }),
        execute: () =>
          sql`
            SELECT DISTINCT started.session_id FROM session_events AS started
            WHERE started.type = 'TurnStarted' AND NOT EXISTS (
              SELECT 1 FROM session_events AS ended
              WHERE ended.session_id = started.session_id AND ended.turn_id = started.turn_id AND ended.type = 'TurnEnded'
            )
          `
      })

      return {
        append: Effect.fn("SessionEventRepo.append")(function*(sessionId, expected, events) {
          const createdAt = yield* DateTime.now
          const stored = yield* append({ sessionId, expected, events, createdAt })
          // RETURNING does not promise an order.
          return Array.sortWith(stored, (event) => event.seq, Order.Number)
        }, Effect.catchTag("SchemaError", Effect.die)),
        readFrom: Effect.fn("SessionEventRepo.readFrom")((sessionId, from) =>
          readFrom({ sessionId, from }).pipe(Effect.catchTag("SchemaError", Effect.die))
        ),
        nextSeq: Effect.fn("SessionEventRepo.nextSeq")((sessionId) =>
          nextSeq(sessionId).pipe(
            Effect.map((row) => row.pipe(Option.map(({ next }) => next))),
            Effect.catchTag("SchemaError", Effect.die)
          )
        ),
        withUnfinishedTurns: withUnfinishedTurns(undefined).pipe(
          Effect.map((rows) => rows.map((row) => row.sessionId)),
          Effect.catchTag("SchemaError", Effect.die),
          Effect.withSpan("SessionEventRepo.withUnfinishedTurns")
        )
      } satisfies SessionEventRepoShape
    })
  }
) {
  static readonly layer = Layer.effect(SessionEventRepo, SessionEventRepo.make)
}
