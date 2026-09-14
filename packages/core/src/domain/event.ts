import { Schema } from "effect"

// CONVERSATION EVENTS — the durable truth of the conversation.
// Domain events at turn granularity. Never transport chunks. Schema-validated at the Transcript boundary.

export const Outcome = Schema.TaggedUnion({
  Completed: {},
  Cancelled: {},
  Failed: { error: Schema.String },
})
export type Outcome = typeof Outcome.Type

export const ConversationEvent = Schema.TaggedUnion({
  PromptAccepted: { prompt: Schema.String },
  TurnEnded: { text: Schema.String, outcome: Outcome },
})
export type ConversationEvent = typeof ConversationEvent.Type
