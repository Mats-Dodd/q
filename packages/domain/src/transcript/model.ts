import { Schema } from "effect"

// CONVERSATION EVENTS — the durable truth of the conversation.
// Domain events at turn granularity. Never transport chunks. Schema-validated at the repository boundary.

export const OutcomeSchema = Schema.TaggedUnion({
  Completed: {},
  Cancelled: {},
  Failed: { error: Schema.String },
})
export type Outcome = typeof OutcomeSchema.Type

export const ConversationEventSchema = Schema.TaggedUnion({
  PromptAccepted: { prompt: Schema.String },
  TurnEnded: { text: Schema.String, outcome: OutcomeSchema },
})
export type ConversationEvent = typeof ConversationEventSchema.Type
