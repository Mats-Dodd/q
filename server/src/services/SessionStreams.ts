import { Array, Context, Effect, Layer, Stream } from "effect"
import type { SqlError } from "effect/sql"
import * as Offset from "../domain/Offset.ts"
import type { SessionId, SessionNotFound } from "../domain/Session.ts"
import type { StoredEvent } from "../domain/SessionEvent.ts"
import type { StreamChunk } from "../domain/StreamChunk.ts"
import { streamChunksOf } from "../domain/StreamProjection.ts"
import { SessionEventLog } from "./SessionEventLog.ts"

/** Chunks read from a session stream, and the offset just past them. */
export interface StreamRead {
  readonly chunks: ReadonlyArray<StreamChunk>
  readonly next: Offset.Offset
}

/**
 * Session streams: what clients read. A session's stream is its event log,
 * projected (`streamChunksOf`); an offset is an event's seq, so every read
 * ends on an event boundary. Nothing writes to a stream: sessions append
 * events, and the stream follows.
 */
export interface SessionStreamsShape {
  /** Where the next appended event will be (the protocol's `Stream-Next-Offset`). */
  readonly nextOffset: (sessionId: SessionId) => Effect.Effect<Offset.Offset, SessionNotFound | SqlError.SqlError>
  /** A catch-up read: everything from `from` to the end. */
  readonly catchUp: (
    sessionId: SessionId,
    from: Offset.ReadFrom
  ) => Effect.Effect<StreamRead, SessionNotFound | SqlError.SqlError>
  /**
   * A live read: the catch-up from `from` (possibly empty), then each append as
   * it happens.
   */
  readonly follow: (
    sessionId: SessionId,
    from: Offset.ReadFrom
  ) => Stream.Stream<StreamRead, SessionNotFound | SqlError.SqlError>
}

/** What clients see of `events`, read from `from`: reading nothing leaves the offset where it was. */
const readOf = (events: ReadonlyArray<StoredEvent>, from: Offset.Offset): StreamRead => ({
  chunks: Array.flatMap(events, (stored) => streamChunksOf(stored.event)),
  next: Array.isReadonlyArrayNonEmpty(events) ? Offset.after(Array.lastNonEmpty(events).seq) : from
})

export class SessionStreams extends Context.Service<SessionStreams, SessionStreamsShape>()(
  "@q/server/services/SessionStreams",
  {
    make: Effect.gen(function*() {
      const log = yield* SessionEventLog

      const nextOffset = Effect.fn("SessionStreams.nextOffset")(function*(sessionId: SessionId) {
        return Offset.Offset.make(yield* log.nextSeq(sessionId))
      })

      /** `now` is the end of the stream as of this read. */
      const resolve = (sessionId: SessionId, from: Offset.ReadFrom) =>
        from === "now" ? nextOffset(sessionId) : log.nextSeq(sessionId).pipe(Effect.as(from))

      const catchUp = Effect.fn("SessionStreams.catchUp")(function*(sessionId: SessionId, from: Offset.ReadFrom) {
        const start = yield* resolve(sessionId, from)
        return readOf(yield* log.readFrom(sessionId, start), start)
      })

      const follow = (sessionId: SessionId, from: Offset.ReadFrom) =>
        Stream.unwrap(resolve(sessionId, from).pipe(
          Effect.map((start) =>
            log.follow(sessionId, start).pipe(
              Stream.mapAccum(() => start, (offset, events) => {
                const read = readOf(events, offset)
                return [read.next, [read]]
              })
            )
          )
        ))

      return { nextOffset, catchUp, follow } satisfies SessionStreamsShape
    })
  }
) {
  static readonly layer = Layer.effect(SessionStreams, SessionStreams.make)
}
