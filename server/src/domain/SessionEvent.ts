import { Data, Schema } from "effect"
import { Response, Toolkit } from "effect/ai"
import { MessageId, MessageText, TurnId } from "./Turn.ts"

/**
 * What happened in a session: the single record everything else is projected
 * from (the stream clients read, the history the model is given). Events are
 * never changed once written; new kinds of events, or new optional fields,
 * are how this evolves.
 *
 * A turn is `TurnStarted`, then steps (`StepStarted` and the model's raw
 * output, batched into `ModelOutput`s), then `TurnEnded`.
 */

/** The user's message starts a turn. */
export const TurnStarted = Schema.TaggedStruct("TurnStarted", {
  turnId: TurnId,
  messageId: MessageId,
  text: MessageText,
  model: Schema.String
})

/** A model call begins. */
export const StepStarted = Schema.TaggedStruct("StepStarted", { turnId: TurnId })

/**
 * What the model streamed, exactly as `effect/ai` delivered it: every delta,
 * with reasoning signatures, provider metadata and ids.
 */
export const ModelOutput = Schema.TaggedStruct("ModelOutput", {
  turnId: TurnId,
  parts: Schema.NonEmptyArray(Response.StreamPart(Toolkit.empty))
})

export const TurnOutcome = Schema.Union([
  Schema.TaggedStruct("Completed", { finishReason: Response.FinishReason }),
  Schema.TaggedStruct("Cancelled", {}),
  Schema.TaggedStruct("Failed", { message: Schema.String })
]).pipe(Schema.toTaggedUnion("_tag"))
export type TurnOutcome = typeof TurnOutcome.Type

export const TurnEnded = Schema.TaggedStruct("TurnEnded", { turnId: TurnId, outcome: TurnOutcome })

export const SessionEvent = Schema.Union([TurnStarted, StepStarted, ModelOutput, TurnEnded]).pipe(
  Schema.toTaggedUnion("_tag")
)
export type SessionEvent = typeof SessionEvent.Type

/** An event as stored: JSON. */
export const SessionEventJson = Schema.fromJsonString(Schema.toCodecJson(SessionEvent))

/** An event and its position in the session's log (the stream offset it projects to). */
export interface StoredEvent {
  readonly seq: number
  readonly event: SessionEvent
}

/** Someone else appended since this writer last read: its view of the session is stale. */
export class VersionConflict extends Data.TaggedError("VersionConflict")<{ readonly expected: number }> {}
