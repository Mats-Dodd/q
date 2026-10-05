import { Array, Context, Effect, Layer, PubSub, RcMap, Stream } from "effect"
import { SqlClient, type SqlError } from "effect/sql"
import { type SessionId, SessionNotFound } from "../domain/Session.ts"
import { type SessionEvent, type StoredEvent, VersionConflict } from "../domain/SessionEvent.ts"
import { SessionEventRepo } from "./SessionEventRepo.ts"
import { SessionRepo } from "./SessionRepo.ts"

/**
 * Session event logs: the single record of what happened in each session, and
 * live delivery of what is appended to it.
 *
 * Appends are checked against the writer's version (the seq it expects the
 * first new event to get), so a writer with a stale view fails rather than
 * interleaving; in practice each session's runtime is its only writer. An
 * append also marks the session as used (its `updatedAt`), in the same
 * transaction, and is published to the session's followers once committed:
 * nothing is seen that could still be rolled back.
 */
/** The seq just past `events`, or `fallback` if there are none. */
const nextAfter = (events: ReadonlyArray<StoredEvent>, fallback: number) =>
  Array.isReadonlyArrayNonEmpty(events) ? Array.lastNonEmpty(events).seq + 1 : fallback

export interface SessionEventLogShape {
  /** Appends `events` if the log is at `expected`, returning them as stored. */
  readonly append: (
    sessionId: SessionId,
    expected: number,
    events: Array.NonEmptyReadonlyArray<SessionEvent>
  ) => Effect.Effect<Array.NonEmptyReadonlyArray<StoredEvent>, VersionConflict | SqlError.SqlError>
  /** The seq the next event will get. */
  readonly nextSeq: (sessionId: SessionId) => Effect.Effect<number, SessionNotFound | SqlError.SqlError>
  /** Every event from `from`, in order. */
  readonly readFrom: (sessionId: SessionId, from: number) => Effect.Effect<ReadonlyArray<StoredEvent>, SqlError.SqlError>
  /** Everything from `from` (the first element, possibly empty), then each append as it happens. */
  readonly follow: (sessionId: SessionId, from: number) => Stream.Stream<ReadonlyArray<StoredEvent>, SqlError.SqlError>
  /** Sessions with a turn that started and never ended. */
  readonly withUnfinishedTurns: Effect.Effect<ReadonlyArray<SessionId>, SqlError.SqlError>
}

export class SessionEventLog extends Context.Service<SessionEventLog, SessionEventLogShape>()(
  "@q/server/services/SessionEventLog",
  {
    make: Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const repo = yield* SessionEventRepo
      const sessions = yield* SessionRepo
      /** Per session, the appends its followers are waiting for. */
      const live = yield* RcMap.make<SessionId, PubSub.PubSub<Array.NonEmptyReadonlyArray<StoredEvent>>, never, never>({
        lookup: () => PubSub.unbounded()
      })

      const append = Effect.fn("SessionEventLog.append")(function*(
        sessionId: SessionId,
        expected: number,
        events: Array.NonEmptyReadonlyArray<SessionEvent>
      ) {
        yield* Effect.annotateCurrentSpan({ sessionId, events: events.length })
        const stored = yield* sql.withTransaction(Effect.gen(function*() {
          const appended = yield* repo.append(sessionId, expected, events)
          if (!Array.isReadonlyArrayNonEmpty(appended)) {
            return yield* new VersionConflict({ expected })
          }
          yield* sessions.touch(sessionId)
          return appended
        }))
        // A follower that subscribes after this check catches up from the database.
        if (yield* RcMap.has(live, sessionId)) {
          yield* Effect.scoped(RcMap.get(live, sessionId).pipe(Effect.flatMap((hub) => PubSub.publish(hub, stored))))
        }
        return stored
      })

      const nextSeq = Effect.fn("SessionEventLog.nextSeq")(function*(sessionId: SessionId) {
        const next = yield* repo.nextSeq(sessionId)
        return yield* Effect.fromOption(next, () => SessionNotFound.make({ id: sessionId }))
      })

      const follow = (sessionId: SessionId, from: number): Stream.Stream<ReadonlyArray<StoredEvent>, SqlError.SqlError> =>
        Stream.unwrap(Effect.gen(function*() {
          // Subscribe before catching up, so nothing appended in between is missed;
          // anything the catch-up already covered is dropped from the live side.
          const subscription = yield* PubSub.subscribe(yield* RcMap.get(live, sessionId))
          const caughtUp = yield* repo.readFrom(sessionId, from)
          const appends = Stream.fromSubscription(subscription).pipe(
            Stream.mapAccum(() => nextAfter(caughtUp, from), (next, appended) => {
              const unseen = Array.filter(appended, (event) => event.seq >= next)
              return Array.isReadonlyArrayNonEmpty(unseen) ? [nextAfter(unseen, next), [unseen]] : [next, []]
            })
          )
          return Stream.concat(Stream.succeed(caughtUp), appends)
        }))

      return {
        append,
        nextSeq,
        readFrom: repo.readFrom,
        follow,
        withUnfinishedTurns: repo.withUnfinishedTurns
      } satisfies SessionEventLogShape
    })
  }
) {
  static readonly layer = Layer.effect(SessionEventLog, SessionEventLog.make)
}
