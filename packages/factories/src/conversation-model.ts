import { TurnSchema } from "@q/domain/conversation/model"
import type { ChatMessage, ChatMessagePart, ConversationModel } from "@q/domain/conversation/model"
import { Option } from "effect"

export const idleModel: ConversationModel = {
  messages: [],
  turn: TurnSchema.cases.Idle.make({}),
  nextId: 0,
  notice: Option.none(),
}

/** The text parts of a message, joined. For assertions that care about what was said, not how it is split. */
export const textOf = (message: ChatMessage | undefined): string =>
  message?.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("") ?? ""

/** A user message with one text part. */
export const makeUserMessage = (id: string, text: string): ChatMessage => ({ id, role: "user", parts: [{ type: "text", text }] })

/** An assistant message. The default `parts` are one finished step of text. */
export const makeAssistantMessage = (id: string, parts: ReadonlyArray<ChatMessagePart>): ChatMessage => ({ id, role: "assistant", parts })

/** The parts of one step that answered with `text`: `step-start`, then a done text part. */
export const makeTextStep = (text: string, state: "done" | "streaming" = "done"): ReadonlyArray<ChatMessagePart> => [
  { type: "step-start" },
  { type: "text", id: "text-0", text, state },
]

/** A finished exchange: `prompt` was answered with `reply`. */
export const makeAnsweredModel = (prompt: string, reply: string, overrides: Partial<ConversationModel> = {}): ConversationModel => ({
  messages: [makeUserMessage("0", prompt), makeAssistantMessage("1", makeTextStep(reply))],
  turn: TurnSchema.cases.Idle.make({}),
  nextId: 2,
  notice: Option.none(),
  ...overrides,
})

/** A `bash` call waiting on the user, as the assistant message holds it. */
export const makeBashApprovalPart = (toolCallId = "call-1", approvalId = "approval-1", command = "make"): ChatMessagePart => ({
  type: "tool-bash",
  toolCallId,
  state: "approval-requested",
  input: { command },
  approval: { id: approvalId },
})

/** Parked: `prompt` led to a `bash` call the user must approve. */
export const makeAwaitingApprovalModel = (prompt: string, overrides: Partial<ConversationModel> = {}): ConversationModel => ({
  ...makeAnsweredModel(prompt, ""),
  messages: [makeUserMessage("0", prompt), makeAssistantMessage("1", [{ type: "step-start" }, makeBashApprovalPart()])],
  turn: TurnSchema.cases.AwaitingApproval.make({ messageId: "1", round: 0 }),
  ...overrides,
})

/** Mid-turn: `prompt` is being answered, `partial` has arrived so far. */
export const makeStreamingModel = (prompt: string, partial: string, overrides: Partial<ConversationModel> = {}): ConversationModel => ({
  ...makeAnsweredModel(prompt, partial),
  messages: [makeUserMessage("0", prompt), makeAssistantMessage("1", makeTextStep(partial, "streaming"))],
  turn: TurnSchema.cases.Streaming.make({ messageId: "1", round: 0 }),
  ...overrides,
})
