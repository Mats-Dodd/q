import { type Cause, Context, Data, type Effect } from "effect"

import type { ConversationEvent } from "../domain/event"
import type { Session, SessionId } from "../domain/session"

// TRANSCRIPT REPOSITORY — sessions and their events, in storage. The tag lives here; every Layer
// lives in @q/db. Parse, do not validate: rows become domain values at this boundary or they are
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
>()("TranscriptRepository") {}
