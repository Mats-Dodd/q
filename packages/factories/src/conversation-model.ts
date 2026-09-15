import { type ChatMessage, type ConversationModel, TurnSchema } from "@q/domain/conversation/model"
import { Option } from "effect"

export const idleModel: ConversationModel = {
  messages: [],
  turn: TurnSchema.cases.Idle.make({}),
  nextId: 0,
  notice: Option.none(),
}

/** A finished exchange: `prompt` was answered with `reply`. */
export const makeAnsweredModel = (prompt: string, reply: string, overrides: Partial<ConversationModel> = {}): ConversationModel => ({
  messages: [
    { id: 0, role: "user", text: prompt },
    { id: 1, role: "assistant", text: reply },
  ] satisfies ReadonlyArray<ChatMessage>,
  turn: TurnSchema.cases.Idle.make({}),
  nextId: 2,
  notice: Option.none(),
  ...overrides,
})

/** Mid-turn: `prompt` is being answered, `partial` has arrived so far. */
export const makeStreamingModel = (prompt: string, partial: string, overrides: Partial<ConversationModel> = {}): ConversationModel => ({
  ...makeAnsweredModel(prompt, partial),
  turn: TurnSchema.cases.Streaming.make({ messageId: 1, prompt }),
  ...overrides,
})
