import { SessionId } from "@q/domain/session/model"
import { type ConversationEvent, ConversationEventSchema } from "@q/domain/transcript/model"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { SqlClient, type SqlError, SqlSchema } from "effect/unstable/sql"

// The append-only event log, one row per event. Rows are this module's own writes: a row that does not decode dies.

interface TranscriptRepositoryInterface {
  readonly insert: (sessionId: SessionId, event: ConversationEvent) => Effect.Effect<void, SqlError.SqlError>
  /** The events of one session in append order. */
  readonly findBySessionId: (sessionId: SessionId) => Effect.Effect<ReadonlyArray<ConversationEvent>, SqlError.SqlError>
}

const EventBody = Schema.fromJsonString(ConversationEventSchema)

export class TranscriptRepository extends Context.Service<TranscriptRepository, TranscriptRepositoryInterface>()(
  "@q/core/transcript/transcript-repository/TranscriptRepository",
) {
  static readonly layer = Layer.effect(
    TranscriptRepository,
    Effect.gen(function* layer() {
      const sql = yield* SqlClient.SqlClient

      const insertQuery = SqlSchema.void({
        Request: Schema.Struct({ sessionId: SessionId, kind: Schema.String, body: EventBody, createdAt: Schema.DateTimeUtcFromMillis }),
        execute: (row) => sql`INSERT INTO transcript_event ${sql.insert(row)}`,
      })

      const findBySessionIdQuery = SqlSchema.findAll({
        Request: SessionId,
        Result: Schema.Struct({ body: EventBody }),
        execute: (sessionId) => sql`SELECT body FROM transcript_event WHERE session_id = ${sessionId} ORDER BY seq`,
      })

      const insert = Effect.fn("TranscriptRepository.insert")(
        function* insert(sessionId: SessionId, event: ConversationEvent) {
          const createdAt = yield* DateTime.now
          yield* insertQuery({ sessionId, kind: event._tag, body: event, createdAt })
        },
        Effect.catchTag("SchemaError", Effect.die),
      )

      const findBySessionId = Effect.fn("TranscriptRepository.findBySessionId")(
        function* findBySessionId(sessionId: SessionId) {
          const rows = yield* findBySessionIdQuery(sessionId)
          return rows.map((row) => row.body)
        },
        Effect.catchTag("SchemaError", Effect.die),
      )

      return TranscriptRepository.of({ insert, findBySessionId })
    }),
  )
}
