import { Array, Option, Struct } from "effect"

import type { Program } from "@q/kit"
import { AcceptPrompt, CommitTurn } from "./command"
import { ConversationEvent, Outcome } from "./domain/event"
import { type ChatMessage, type Model, Turn } from "./domain/model"
import { Message } from "./message"
import type { Transcript } from "./services/transcript"

type Return = Program.Return<Model, Message, Transcript>

// FLAGS + INIT

export interface Flags {
  readonly events: ReadonlyArray<ConversationEvent>
}

const empty: Model = { messages: [], turn: Turn.Idle(), nextId: 0, notice: Option.none() }

/** A transcript that ends mid-turn was interrupted. The Model says so; repairing the transcript is a follow-up. */
const INTERRUPTED = "[interrupted]"

/** Fold the durable events into a Model. A resumed Model equals the live one for the same events. */
export const init = (flags: Flags): Return => {
  const folded = flags.events.reduce(applyEvent, empty)
  return { model: folded.turn._tag === "Streaming" ? endTurn(appendText(folded, folded.turn.messageId, INTERRUPTED)) : folded }
}

const applyEvent = (model: Model, event: ConversationEvent): Model =>
  ConversationEvent.match(event, {
    PromptAccepted: ({ prompt }) => beginStreaming(model, prompt),
    TurnEnded: ({ text }) =>
      model.turn._tag === "Streaming" ? endTurn(appendText(model, model.turn.messageId, text)) : model,
  })

// UPDATE

const beginStreaming = (model: Model, prompt: string): Model => {
  const userId = model.nextId
  const assistantId = model.nextId + 1
  return Struct.evolve(model, {
    messages: Array.appendAll([
      { id: userId, role: "user", text: prompt },
      { id: assistantId, role: "assistant", text: "" },
    ] satisfies ReadonlyArray<ChatMessage>),
    turn: () => Turn.Streaming({ messageId: assistantId, prompt }),
    nextId: (n) => n + 2,
  })
}

const appendText = (model: Model, messageId: number, chunk: string): Model =>
  Struct.evolve(model, {
    messages: Array.map((message: ChatMessage) =>
      message.id === messageId ? Struct.evolve(message, { text: (text) => text + chunk }) : message,
    ),
  })

const textOf = (model: Model, messageId: number): string =>
  model.messages.find((message) => message.id === messageId)?.text ?? ""

const endTurn = (model: Model): Model => Struct.evolve(model, { turn: () => Turn.Idle() })

const endTurnWithNotice = (model: Model, notice: string): Model =>
  Struct.evolve(model, { turn: () => Turn.Idle(), notice: () => Option.some(notice) })

/**
 * End the turn now and record the outcome behind it. Leaving `Streaming` stops the agent;
 * the transcript Layer orders the append after anything already in flight.
 */
const commit = (model: Model, messageId: number, outcome: Outcome): Return => ({
  model: endTurn(model),
  commands: [CommitTurn({ messageId, text: textOf(model, messageId), outcome })],
})

const isStreaming = (model: Model, messageId: number) =>
  model.turn._tag === "Streaming" && model.turn.messageId === messageId

/** Every branch checks the turn state and id. A message that does not fit the current state leaves the Model untouched, by reference. */
export const update = (model: Model, message: Message): Return =>
  Message.match(message, {
    SubmittedPrompt: ({ text }) =>
      model.turn._tag !== "Idle" || text.trim() === ""
        ? { model }
        : {
            model: Struct.evolve(model, { turn: () => Turn.Accepting({ prompt: text }), notice: () => Option.none() }),
            commands: [AcceptPrompt({ prompt: text })],
          },
    SucceededAcceptPrompt: () =>
      model.turn._tag === "Accepting" ? { model: beginStreaming(model, model.turn.prompt) } : { model },
    FailedAcceptPrompt: ({ error }) =>
      model.turn._tag === "Accepting" ? { model: endTurnWithNotice(model, `could not save prompt: ${error}`) } : { model },
    ReceivedText: ({ messageId, text }) =>
      isStreaming(model, messageId) ? { model: appendText(model, messageId, text) } : { model },
    CompletedTurn: ({ messageId }) =>
      isStreaming(model, messageId) ? commit(model, messageId, Outcome.Completed()) : { model },
    FailedTurn: ({ messageId, error }) =>
      isStreaming(model, messageId)
        ? commit(appendText(model, messageId, ` [error: ${error}]`), messageId, Outcome.Failed({ error }))
        : { model },
    PressedEscape: () =>
      model.turn._tag === "Streaming" ? commit(model, model.turn.messageId, Outcome.Cancelled()) : { model },
    SucceededCommitTurn: () => ({ model }),
    // The turn is already over; a failed record is a notice, whatever the conversation is doing now.
    FailedCommitTurn: ({ error }) => ({ model: Struct.evolve(model, { notice: () => Option.some(`could not save turn: ${error}`) }) }),
  })
