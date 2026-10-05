import { Array, Context, Effect, Layer, PubSub, RcMap, Stream } from "effect"
import type { SqlError } from "effect/sql"
import * as Offset from "../domain/Offset.ts"
import { type SessionId, SessionNotFound } from "../domain/Session.ts"
import type { StreamChunk } from "../domain/StreamChunk.ts"
import { type StoredChunk, StreamChunkRepo } from "./StreamChunkRepo.ts"

/** A contiguous run of a stream's chunks, and the offset just past it. */
export interface StreamRead {
  readonly chunks: ReadonlyArray<StreamChunk>
  readonly next: Offset.Offset
}

/**
 * Session streams: the durable log every client reads, and the only way
 * anything is written to it.
 *
 * Each session has one writer (its `SessionRuntime`), so its appends are
 * stored and published in order and live readers see a gapless sequence.
 * Appends are published to the session's own PubSub, which exists only while
 * someone is reading live.
 */
export interface SessionStreamsShape {
  /** Appends to a session's stream, returning the offset just past the new chunks. */
  readonly append: (
    sessionId: SessionId,
    chunks: Array.NonEmptyReadonlyArray<StreamChunk>
  ) => Effect.Effect<Offset.Offset, SqlError.SqlError>
  /** Where the next appended chunk will be (the protocol's `Stream-Next-Offset`). */
  readonly nextOffset: (sessionId: SessionId) => Effect.Effect<Offset.Offset, SessionNotFound | SqlError.SqlError>
  /** A catch-up read: everything from `from` to the end. */
  readonly catchUp: (sessionId: SessionId, from: Offset.ReadFrom) => Effect.Effect<StreamRead, SessionNotFound | SqlError.SqlError>
  /**
   * A live read: the catch-up from `from` (possibly empty), then each append as
   * it happens. Ends if the session is deleted.
   */
  readonly follow: (sessionId: SessionId, from: Offset.ReadFrom) => Stream.Stream<StreamRead, SqlError.SqlError>
}

export class SessionStreams extends Context.Service<SessionStreams, SessionStreamsShape>()("@q/server/services/SessionStreams", {
  make: Effect.gen(function*() {
    const repo = yield* StreamChunkRepo
    /** Per session, the appends its live readers are waiting for. */
    const live = yield* RcMap.make<SessionId, PubSub.PubSub<Array.NonEmptyReadonlyArray<StoredChunk>>, never, never>({
      lookup: () => PubSub.unbounded()
    })

    const append = Effect.fn("SessionStreams.append")(function*(
      sessionId: SessionId,
      chunks: Array.NonEmptyReadonlyArray<StreamChunk>
    ) {
      yield* Effect.annotateCurrentSpan({ sessionId, chunks: chunks.length })
      const stored = yield* repo.append(sessionId, chunks)
      // A reader that subscribes after this check catches up from the database.
      if (yield* RcMap.has(live, sessionId)) {
        yield* Effect.scoped(RcMap.get(live, sessionId).pipe(Effect.flatMap((readers) => PubSub.publish(readers, stored))))
      }
      return Offset.after(Array.lastNonEmpty(stored).seq)
    })

    const nextOffset = Effect.fn("SessionStreams.nextOffset")(function*(sessionId: SessionId) {
      yield* Effect.annotateCurrentSpan({ sessionId })
      const next = yield* repo.nextSeq(sessionId)
      return Offset.Offset.make(yield* Effect.fromOption(next, () => SessionNotFound.make({ id: sessionId })))
    })

    const catchUp = Effect.fn("SessionStreams.catchUp")(function*(sessionId: SessionId, from: Offset.ReadFrom) {
      const end = yield* nextOffset(sessionId)
      if (from === "now") {
        return { chunks: [], next: end } satisfies StreamRead
      }
      return readOf(yield* repo.readFrom(sessionId, from), from)
    })

    const follow = (sessionId: SessionId, from: Offset.ReadFrom): Stream.Stream<StreamRead, SqlError.SqlError> =>
      Stream.unwrap(Effect.gen(function*() {
        // Subscribe before catching up, so nothing appended in between is missed;
        // anything the catch-up already covered is dropped from the live side.
        const subscription = yield* PubSub.subscribe(yield* RcMap.get(live, sessionId))
        const caughtUp = yield* catchUp(sessionId, from)
        const appends = Stream.fromSubscription(subscription).pipe(
          Stream.mapAccum(() => caughtUp.next, (next, appended) => {
            const unseen = Array.filter(appended, (chunk) => chunk.seq >= next)
            if (!Array.isReadonlyArrayNonEmpty(unseen)) {
              return [next, []]
            }
            const read = readOf(unseen, next)
            return [read.next, [read]]
          })
        )
        return Stream.concat(Stream.succeed(caughtUp), appends)
      })).pipe(Stream.catchTag("SessionNotFound", () => Stream.empty))

    return { append, nextOffset, catchUp, follow } satisfies SessionStreamsShape
  })
}) {
  static readonly layer = Layer.effect(SessionStreams, SessionStreams.make)
}

/** The read of `stored`, made from `from`: reading nothing leaves the offset where it was. */
const readOf = (stored: ReadonlyArray<StoredChunk>, from: Offset.Offset): StreamRead => ({
  chunks: Array.map(stored, (chunk) => chunk.chunk),
  next: Array.isReadonlyArrayNonEmpty(stored) ? Offset.after(Array.lastNonEmpty(stored).seq) : from
})
