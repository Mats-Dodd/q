import { Schema } from "effect"

// MODEL

export const Role = Schema.Literals(["user", "assistant"])
export type Role = typeof Role.Type

export const ChatMessage = Schema.Struct({
  id: Schema.Number,
  role: Role,
  text: Schema.String,
})
export type ChatMessage = typeof ChatMessage.Type

/**
 * Where the conversation is. The start of a turn is write-ahead: a prompt enters `messages`
 * only after the transcript has accepted it, and that wait is the `Accepting` state. The end
 * of a turn is write-behind: leaving `Streaming` records the outcome asynchronously.
 */
export const Turn = Schema.TaggedUnion({
  Idle: {},
  /** `PromptAccepted` is being appended to the transcript. The view may show the prompt as pending. */
  Accepting: { prompt: Schema.String },
  /** The agent is producing text into the row `messageId`. Text is display state until the turn ends. */
  Streaming: { messageId: Schema.Number, prompt: Schema.String },
})
export type Turn = typeof Turn.Type

export const Model = Schema.Struct({
  messages: Schema.Array(ChatMessage),
  turn: Turn,
  /** Next row id. A counter in the Model so `update` stays pure. */
  nextId: Schema.Number,
  /** A one-line problem to show the user, cleared on the next prompt. */
  notice: Schema.Option(Schema.String),
})
export type Model = typeof Model.Type
