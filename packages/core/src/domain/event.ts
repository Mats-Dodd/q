import { Schema } from "effect"

import { defineTaggedUnion } from "@q/kit"

// CONVERSATION EVENTS — the durable truth of the conversation.
// Domain events at turn granularity. Never transport chunks. Schema-validated at the Transcript boundary.

export const Outcome = defineTaggedUnion({
  Completed: {},
  Cancelled: {},
  Failed: { error: Schema.String },
})
export type Outcome = typeof Outcome.Type

export const ConversationEvent = defineTaggedUnion({
  PromptAccepted: { prompt: Schema.String },
  TurnEnded: { text: Schema.String, outcome: Outcome },
})
export type ConversationEvent = typeof ConversationEvent.Type
