import { IntentSchema } from "@q/domain/conversation/model"
import { Schema } from "effect"

// MESSAGE — inputs to `update`, named as past-tense facts. Transient, never persisted.
// The intents are the domain's own schemas, not copies: a client sends one as it is.

export const MessageSchema = Schema.Union([
  ...IntentSchema.members,
  Schema.TaggedStruct("SucceededAcceptPrompt", {}),
  Schema.TaggedStruct("FailedAcceptPrompt", { error: Schema.String }),
  Schema.TaggedStruct("ReceivedText", { messageId: Schema.Int, text: Schema.String }),
  Schema.TaggedStruct("CompletedTurn", { messageId: Schema.Int }),
  Schema.TaggedStruct("FailedTurn", { messageId: Schema.Int, error: Schema.String }),
  Schema.TaggedStruct("SucceededCommitTurn", { messageId: Schema.Int }),
  Schema.TaggedStruct("FailedCommitTurn", { messageId: Schema.Int, error: Schema.String }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type Message = typeof MessageSchema.Type
