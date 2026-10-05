import { Array, Context, Effect, Layer, Option, Order, Schema } from "effect"
import { SqlClient, type SqlError, SqlSchema } from "effect/sql"
import { SessionId } from "../domain/Session.ts"
import { StreamChunk } from "../domain/StreamChunk.ts"

/** A chunk as stored: JSON text in the `chunk` column. */
const ChunkJson = Schema.fromJsonString(Schema.toCodecJson(StreamChunk))

const StoredChunk = Schema.Struct({ seq: Schema.Int, chunk: ChunkJson })
export type StoredChunk = typeof StoredChunk.Type

/**
 * Persistence for session streams: an append-only log of chunks per session,
 * numbered by `seq` from 0 with no gaps.
 *
 * - `append` is one statement that numbers the new chunks from the stream's end, so
 *   there is no read-then-write window. It fails (foreign key) for a session
 *   that does not exist; deleting a session deletes its stream.
 * - Rows that fail to decode are corrupt data or a bug, so they are defects.
 */
export interface StreamChunkRepoShape {
  /** The stored chunks, in order. */
  readonly append: (
    sessionId: SessionId,
    chunks: Array.NonEmptyReadonlyArray<StreamChunk>
  ) => Effect.Effect<Array.NonEmptyReadonlyArray<StoredChunk>, SqlError.SqlError>
  /** Every chunk with `seq >= from`, in order. */
  readonly readFrom: (sessionId: SessionId, from: number) => Effect.Effect<ReadonlyArray<StoredChunk>, SqlError.SqlError>
  /** The `seq` the next chunk will get; `None` when no session has that id. */
  readonly nextSeq: (sessionId: SessionId) => Effect.Effect<Option.Option<number>, SqlError.SqlError>
}

export class StreamChunkRepo extends Context.Service<StreamChunkRepo, StreamChunkRepoShape>()("@q/server/services/StreamChunkRepo", {
  make: Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient

    const append = SqlSchema.findNonEmpty({
      Request: Schema.Struct({ sessionId: SessionId, chunks: Schema.fromJsonString(Schema.Array(Schema.toCodecJson(StreamChunk))) }),
      Result: StoredChunk,
      execute: ({ chunks, sessionId }) =>
        sql`
          INSERT INTO stream_chunks (session_id, seq, chunk)
          SELECT ${sessionId}, stream_end.next + incoming.key, incoming.value
          FROM (SELECT COALESCE(MAX(seq) + 1, 0) AS next FROM stream_chunks WHERE session_id = ${sessionId}) AS stream_end,
               json_each(${chunks}) AS incoming
          ORDER BY incoming.key
          RETURNING seq, chunk
        `
    })

    const readFrom = SqlSchema.findAll({
      Request: Schema.Struct({ sessionId: SessionId, from: Schema.Int }),
      Result: StoredChunk,
      execute: ({ from, sessionId }) =>
        sql`SELECT seq, chunk FROM stream_chunks WHERE session_id = ${sessionId} AND seq >= ${from} ORDER BY seq`
    })

    const nextSeq = SqlSchema.findOneOption({
      Request: SessionId,
      Result: Schema.Struct({ next: Schema.Int }),
      execute: (id) =>
        sql`
          SELECT (SELECT COALESCE(MAX(seq) + 1, 0) FROM stream_chunks WHERE session_id = sessions.id) AS next
          FROM sessions WHERE id = ${id}
        `
    })

    return {
      append: Effect.fn("StreamChunkRepo.append")((sessionId, chunks) =>
        append({ sessionId, chunks }).pipe(
          // RETURNING does not promise an order.
          Effect.map(Array.sortWith((stored) => stored.seq, Order.Number)),
          // Inserting chunks and getting none back is a bug.
          Effect.catchTags({ NoSuchElementError: Effect.die, SchemaError: Effect.die })
        )
      ),
      readFrom: Effect.fn("StreamChunkRepo.readFrom")((sessionId, from) =>
        readFrom({ sessionId, from }).pipe(Effect.catchTag("SchemaError", Effect.die))
      ),
      nextSeq: Effect.fn("StreamChunkRepo.nextSeq")((sessionId) =>
        nextSeq(sessionId).pipe(
          Effect.map((row) => row.pipe(Option.map(({ next }) => next))),
          Effect.catchTag("SchemaError", Effect.die)
        )
      )
    } satisfies StreamChunkRepoShape
  })
}) {
  static readonly layer = Layer.effect(StreamChunkRepo, StreamChunkRepo.make)
}
