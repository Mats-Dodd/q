import { Schema } from "effect"

// CONVERSATION MODEL — what a client sees of one session. The server folds it; a client mirrors it.

export const RoleSchema = Schema.Literals(["user", "assistant"])
export type Role = typeof RoleSchema.Type

export const ChatMessageSchema = Schema.Struct({
  id: Schema.Int,
  role: RoleSchema,
  text: Schema.String,
})
export type ChatMessage = typeof ChatMessageSchema.Type

/**
 * Where the conversation is. The start of a turn is write-ahead: a prompt enters `messages`
 * only after the transcript has accepted it, and that wait is the `Accepting` state. The end
 * of a turn is write-behind: leaving `Streaming` records the outcome asynchronously.
 */
export const TurnSchema = Schema.TaggedUnion({
  Idle: {},
  /** `PromptAccepted` is being appended to the transcript. The view may show the prompt as pending. */
  Accepting: { prompt: Schema.String },
  /** The agent is producing text into the row `messageId`. Text is display state until the turn ends. */
  Streaming: { messageId: Schema.Int, prompt: Schema.String },
})
export type Turn = typeof TurnSchema.Type

export const ConversationModelSchema = Schema.Struct({
  messages: Schema.Array(ChatMessageSchema),
  turn: TurnSchema,
  /** Next row id. A counter in the Model so `update` stays pure. */
  nextId: Schema.Int,
  /** A one-line problem to show the user, cleared on the next prompt. */
  notice: Schema.Option(Schema.String),
})
export type ConversationModel = typeof ConversationModelSchema.Type

// INTENT — the Messages a client may send. The rest of the program's Messages are facts the server produces.

export const SubmittedPrompt = Schema.TaggedStruct("SubmittedPrompt", { text: Schema.String })
export const PressedEscape = Schema.TaggedStruct("PressedEscape", {})

export const IntentSchema = Schema.Union([SubmittedPrompt, PressedEscape]).pipe(Schema.toTaggedUnion("_tag"))
export type Intent = typeof IntentSchema.Type
