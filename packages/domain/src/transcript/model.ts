import { Schema } from "effect"

import { ChatMessagePartSchema } from "../conversation/model"

// CONVERSATION EVENTS — the durable truth of the conversation.
// Domain events at step granularity. Never transport chunks. Schema-validated at the repository boundary.

export const OutcomeSchema = Schema.TaggedUnion({
  Completed: {},
  Cancelled: {},
  Failed: { error: Schema.String },
})
export type Outcome = typeof OutcomeSchema.Type

/**
 * `parts` is always the whole assistant message so far, not the step's delta: a later step can
 * change an earlier part in place (a tool call approved in step 1 gets its output in step 2).
 * Folding takes the last snapshot.
 */
export const ConversationEventSchema = Schema.TaggedUnion({
  PromptAccepted: { prompt: Schema.String },
  /** One model call ended and the turn goes on: another step follows, or the user is asked to approve a tool call. */
  StepEnded: { parts: Schema.Array(ChatMessagePartSchema) },
  TurnEnded: { parts: Schema.Array(ChatMessagePartSchema), outcome: OutcomeSchema },
})
export type ConversationEvent = typeof ConversationEventSchema.Type
