import { Array, Cause, Context, Data, DateTime, Effect, Layer, Option } from "effect"

import type { ConversationEvent } from "../domain/event"
import { type Session, SessionId } from "../domain/session"

// TRANSCRIPT REPOSITORY — sessions and their events, in storage. The tag lives here; the SQL Layer
// lives in @q/server. Parse, do not validate: rows become domain values at this boundary or they are
// a `TranscriptError`.

/** Storage refused, or returned something that is not a transcript. `message` is for the notice line. */
export class TranscriptError extends Data.TaggedError("TranscriptError")<{ readonly cause: unknown }> {
  override get message(): string {
    const cause = this.cause
    return cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)
  }
}

// SERVICE

export class TranscriptRepository extends Context.Service<
  TranscriptRepository,
  {
    readonly createSession: (cwd: string) => Effect.Effect<Session, TranscriptError>
    /** Sessions started in `cwd`, newest first. */
    readonly sessions: (cwd: string) => Effect.Effect<ReadonlyArray<Session>, TranscriptError>
    /** Fails with `NoSuchElementError` when there is no such session. */
    readonly findSession: (id: SessionId) => Effect.Effect<Session, TranscriptError | Cause.NoSuchElementError>
    readonly append: (id: SessionId, event: ConversationEvent) => Effect.Effect<void, TranscriptError>
    /** The events of one session in append order. */
    readonly events: (id: SessionId) => Effect.Effect<ReadonlyArray<ConversationEvent>, TranscriptError>
  }
>()("TranscriptRepository") {
  /** An in-memory repository. Nothing survives the Layer. For tests and throwaway sessions. */
  static readonly Memory: Layer.Layer<TranscriptRepository> = Layer.sync(TranscriptRepository)(() => {
    const sessions = new Map<SessionId, Session>()
    const events = new Map<SessionId, Array<ConversationEvent>>()
    const find = (id: SessionId) => Option.fromNullishOr(sessions.get(id))
    return {
      createSession: (cwd) =>
        Effect.map(DateTime.now, (createdAt) => {
          const session: Session = { id: SessionId.make(crypto.randomUUID()), cwd, createdAt }
          sessions.set(session.id, session)
          events.set(session.id, [])
          return session
        }),
      sessions: (cwd) =>
        Effect.sync(() =>
          Array.fromIterable(sessions.values())
            .filter((session) => session.cwd === cwd)
            .reverse()
            .sort((a, b) => DateTime.toEpochMillis(b.createdAt) - DateTime.toEpochMillis(a.createdAt)),
        ),
      findSession: (id) =>
        Effect.suspend(() =>
          Option.match(find(id), {
            onNone: () => Effect.fail(new Cause.NoSuchElementError(`no session ${id}`)),
            onSome: Effect.succeed,
          }),
        ),
      append: (id, event) =>
        Effect.sync(() => {
          events.set(id, [...(events.get(id) ?? []), event])
        }),
      events: (id) => Effect.sync(() => events.get(id) ?? []),
    }
  })
}
