import { Schema } from "effect"
import { UIMessage, UIMessagePart } from "effect-ai-ui/UIMessage"
import { UIMessageChunk } from "effect-ai-ui/UIMessageChunk"

import { type AgentTools, AgentToolkit } from "../agent/tools"

// CONVERSATION MODEL — what a client sees of one session. The server folds it; a client mirrors it.
// Messages are AI SDK UI messages, typed by the agent's toolkit: a tool part carries that tool's input and output.

export const ChatMessagePartSchema = UIMessagePart(AgentToolkit)
export type ChatMessagePart = UIMessagePart<AgentTools>

export const ChatMessageSchema = UIMessage(AgentToolkit)
export type ChatMessage = UIMessage<AgentTools>

/** One transport chunk of a step. The agent produces these; `update` folds them into the assistant message. */
export const ChatChunkSchema = UIMessageChunk(AgentToolkit)
export type ChatChunk = UIMessageChunk<AgentTools>

/**
 * Where the conversation is. The start of a turn is write-ahead: a prompt enters `messages`
 * only after the transcript has accepted it, and that wait is the `Accepting` state. The end
 * of a turn is write-behind: leaving `Streaming` records the outcome asynchronously.
 *
 * A turn is a loop of steps. Each step is one model call; a step that ends in tool calls the
 * agent ran is followed by another (`round + 1`). A step that ends in a tool call the user must
 * approve parks the turn in `AwaitingApproval` until the user answers.
 */
export const TurnSchema = Schema.TaggedUnion({
  Idle: {},
  /** `PromptAccepted` is being appended to the transcript. The view may show the prompt as pending. */
  Accepting: { prompt: Schema.String },
  /** The agent is producing step `round` into the assistant message `messageId`. Parts are display state until the step ends. */
  Streaming: { messageId: Schema.String, round: Schema.Int },
  /** Step `round` asked for the user's approval of at least one tool call. Nothing runs until they answer. */
  AwaitingApproval: { messageId: Schema.String, round: Schema.Int },
})
export type Turn = typeof TurnSchema.Type

export const ConversationModelSchema = Schema.Struct({
  messages: Schema.Array(ChatMessageSchema),
  turn: TurnSchema,
  /** Next message id. A counter in the Model so `update` stays pure. */
  nextId: Schema.Int,
  /** A one-line problem to show the user, cleared on the next prompt. */
  notice: Schema.Option(Schema.String),
})
export type ConversationModel = typeof ConversationModelSchema.Type

// INTENT — the Messages a client may send. The rest of the program's Messages are facts the server produces.

export const SubmittedPrompt = Schema.TaggedStruct("SubmittedPrompt", { text: Schema.String })
export const PressedEscape = Schema.TaggedStruct("PressedEscape", {})
/** The user's answer to a tool call in `approval-requested`. */
export const RespondedToolApproval = Schema.TaggedStruct("RespondedToolApproval", { toolCallId: Schema.String, approved: Schema.Boolean })

export const IntentSchema = Schema.Union([SubmittedPrompt, PressedEscape, RespondedToolApproval]).pipe(Schema.toTaggedUnion("_tag"))
export type Intent = typeof IntentSchema.Type
