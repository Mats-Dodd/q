import { Schema } from "effect"

import { defineMessageUnion } from "@q/kit"

// MESSAGE — inputs to `update`, named as past-tense facts. Transient, never persisted.

export const Message = defineMessageUnion({
  SubmittedPrompt: { text: Schema.String },
  SucceededAcceptPrompt: {},
  FailedAcceptPrompt: { error: Schema.String },
  ReceivedText: { messageId: Schema.Number, text: Schema.String },
  CompletedTurn: { messageId: Schema.Number },
  FailedTurn: { messageId: Schema.Number, error: Schema.String },
  PressedEscape: {},
  SucceededCommitTurn: { messageId: Schema.Number },
  FailedCommitTurn: { messageId: Schema.Number, error: Schema.String },
})
export type Message = typeof Message.Type
