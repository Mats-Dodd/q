import { ChatChunkSchema, IntentSchema } from "@q/domain/conversation/model"
import { Schema } from "effect"

// MESSAGE — inputs to `update`, named as past-tense facts. Transient, never persisted.
// The intents are the domain's own schemas, not copies: a client sends one as it is.

const StepRef = { messageId: Schema.String, round: Schema.Int }

export const MessageSchema = Schema.Union([
  ...IntentSchema.members,
  Schema.TaggedStruct("SucceededAcceptPrompt", {}),
  Schema.TaggedStruct("FailedAcceptPrompt", { error: Schema.String }),
  /** One chunk of step `round` for the assistant message `messageId`. `finish-step` is the step's end. */
  Schema.TaggedStruct("ReceivedChunk", { ...StepRef, chunk: ChatChunkSchema }),
  /** The agent's stream failed before `finish-step`. */
  Schema.TaggedStruct("FailedStep", { ...StepRef, error: Schema.String }),
  Schema.TaggedStruct("SucceededCommitStep", StepRef),
  Schema.TaggedStruct("FailedCommitStep", { ...StepRef, error: Schema.String }),
  Schema.TaggedStruct("SucceededCommitTurn", { messageId: Schema.String }),
  Schema.TaggedStruct("FailedCommitTurn", { messageId: Schema.String, error: Schema.String }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type Message = typeof MessageSchema.Type
