import type { AgentTools } from "@q/domain/agent/tools"
import { TurnSchema } from "@q/domain/conversation/model"
import type { ChatChunk, ChatMessage, ChatMessagePart, ConversationModel, Turn } from "@q/domain/conversation/model"
import { ConversationEventSchema, OutcomeSchema } from "@q/domain/transcript/model"
import type { ConversationEvent, Outcome } from "@q/domain/transcript/model"
import type * as Program from "@q/kit/program"
import { Array, Option, Result, Struct } from "effect"
import { isToolUIPart } from "effect-ai-ui/UIMessage"
import type { AnyToolUIPart } from "effect-ai-ui/UIMessage"
import { applyChunk, emptyAssistant, finalize } from "effect-ai-ui/UIMessageReducer"

import type { CurrentSession } from "@q/core/session/current-session"
import type { TranscriptService } from "@q/core/transcript/transcript-service"
import { AcceptPrompt, CommitStep, CommitTurn } from "./command"
import { MessageSchema } from "./message"
import type { Message } from "./message"

type Return = Program.Return<ConversationModel, Message, CurrentSession | TranscriptService>

// FLAGS + INIT

export interface Flags {
  readonly events: ReadonlyArray<ConversationEvent>
}

const empty: ConversationModel = { messages: [], turn: TurnSchema.cases.Idle.make({}), nextId: 0, notice: Option.none() }

/** A transcript that ends mid-step was interrupted. The Model says so; the message keeps what was recorded. */
const INTERRUPTED = "the last turn was interrupted"

/**
 * Fold the durable events into a Model. A resumed Model equals the live one for the same events.
 * A turn parked in `AwaitingApproval` survives a restart: the user can still answer.
 */
export const init = (flags: Flags): Return => {
  const folded = flags.events.reduce(applyEvent, empty)
  return {
    model:
      folded.turn._tag === "Streaming"
        ? Struct.evolve(endTurn(updateMessage(folded, folded.turn.messageId, finalize)), { notice: () => Option.some(INTERRUPTED) })
        : folded,
  }
}

const applyEvent = (model: ConversationModel, event: ConversationEvent): ConversationModel =>
  ConversationEventSchema.match(event, {
    PromptAccepted: ({ prompt }) => beginTurn(model, prompt),
    StepEnded: ({ parts }) =>
      model.turn._tag === "Streaming"
        ? setTurn(withParts(model, model.turn.messageId, parts), afterStep(model.turn.messageId, model.turn.round, parts))
        : model,
    TurnEnded: ({ parts }) =>
      model.turn._tag === "Streaming" || model.turn._tag === "AwaitingApproval"
        ? endTurn(withParts(model, model.turn.messageId, parts))
        : model,
  })

// MODEL HELPERS

const setTurn = (model: ConversationModel, turn: Turn): ConversationModel => Struct.evolve(model, { turn: () => turn })

const endTurn = (model: ConversationModel): ConversationModel => setTurn(model, TurnSchema.cases.Idle.make({}))

const withNotice = (model: ConversationModel, notice: string): ConversationModel =>
  Struct.evolve(model, { notice: () => Option.some(notice) })

const messageOf = (model: ConversationModel, messageId: string): ChatMessage =>
  model.messages.find((message) => message.id === messageId) ?? emptyAssistant<AgentTools>(messageId)

const updateMessage = (model: ConversationModel, messageId: string, f: (message: ChatMessage) => ChatMessage): ConversationModel =>
  Struct.evolve(model, { messages: Array.map((message: ChatMessage) => (message.id === messageId ? f(message) : message)) })

const withParts = (model: ConversationModel, messageId: string, parts: ReadonlyArray<ChatMessagePart>): ConversationModel =>
  updateMessage(model, messageId, (message) => ({ ...message, parts }))

/** Two new messages: the user's prompt and the empty assistant message the steps fill. */
const beginTurn = (model: ConversationModel, prompt: string): ConversationModel => {
  const userId = String(model.nextId)
  const assistantId = String(model.nextId + 1)
  return Struct.evolve(model, {
    messages: Array.appendAll([
      { id: userId, role: "user", parts: [{ type: "text", text: prompt }] },
      emptyAssistant<AgentTools>(assistantId),
    ] satisfies ReadonlyArray<ChatMessage>),
    turn: () => TurnSchema.cases.Streaming.make({ messageId: assistantId, round: 0 }),
    nextId: (n) => n + 2,
  })
}

// THE LOOP — what a finished step means for the turn.

/** The parts after the last `step-start`: what this step produced. */
const lastStep = (parts: ReadonlyArray<ChatMessagePart>): ReadonlyArray<ChatMessagePart> => {
  const start = parts.findLastIndex((part) => part.type === "step-start")
  return start === -1 ? parts : parts.slice(start + 1)
}

const toolParts = (parts: ReadonlyArray<ChatMessagePart>): ReadonlyArray<AnyToolUIPart<AgentTools>> =>
  parts.filter((part): part is AnyToolUIPart<AgentTools> => isToolUIPart(part))

const isPendingApproval = (part: AnyToolUIPart<AgentTools>): boolean => part.state === "approval-requested"

/** A tool call this side ran (or refused): the model has not seen its result yet, so another step must carry it. */
const isResolvedHere = (part: AnyToolUIPart<AgentTools>): boolean =>
  part.providerExecuted !== true && (part.state === "output-available" || part.state === "output-error" || part.state === "output-denied")

type StepVerdict = { readonly _tag: "AwaitApproval" } | { readonly _tag: "Continue" } | { readonly _tag: "Done" }

/**
 * Approval requests park the turn. Tool results the model has not seen call for another step; a step
 * whose client tool calls all have results continues, one with a call left dangling does not (the model
 * would be asked to answer a question nobody finished). Anything else ends the turn.
 */
const verdict = (parts: ReadonlyArray<ChatMessagePart>): StepVerdict => {
  const tools = toolParts(parts)
  if (tools.some(isPendingApproval)) {
    return { _tag: "AwaitApproval" }
  }
  const client = tools.filter((part) => part.providerExecuted !== true)
  if (client.length > 0 && client.every(isResolvedHere)) {
    return { _tag: "Continue" }
  }
  return { _tag: "Done" }
}

/** The turn after a step that did not end it, as the transcript records it: parked, or on to the next round. */
const afterStep = (messageId: string, round: number, parts: ReadonlyArray<ChatMessagePart>): Turn =>
  verdict(parts)._tag === "AwaitApproval"
    ? TurnSchema.cases.AwaitingApproval.make({ messageId, round })
    : TurnSchema.cases.Streaming.make({ messageId, round: round + 1 })

/**
 * End the turn now and record the outcome behind it. Leaving `Streaming` stops the agent;
 * the transcript service orders the append after anything already in flight.
 */
const commit = (model: ConversationModel, messageId: string, outcome: Outcome): Return => {
  const closed = updateMessage(model, messageId, finalize)
  return {
    model: endTurn(closed),
    commands: [CommitTurn({ messageId, parts: messageOf(closed, messageId).parts, outcome })],
  }
}

const finishStep = (model: ConversationModel, messageId: string, round: number): Return => {
  const { parts } = messageOf(model, messageId)
  const next = verdict(lastStep(parts))
  if (next._tag === "Done") {
    return commit(model, messageId, OutcomeSchema.cases.Completed.make({}))
  }
  return {
    model: setTurn(model, afterStep(messageId, round, parts)),
    commands: [CommitStep({ messageId, round, parts })],
  }
}

/** Fold one chunk into the assistant message. `error` and a chunk that does not fit end the turn as failed. */
const receive = (model: ConversationModel, messageId: string, round: number, chunk: ChatChunk): Return => {
  switch (chunk.type) {
    case "error": {
      return commit(
        withNotice(model, `agent failed: ${chunk.errorText}`),
        messageId,
        OutcomeSchema.cases.Failed.make({ error: chunk.errorText }),
      )
    }
    case "finish-step": {
      return finishStep(model, messageId, round)
    }
    default: {
      const applied = applyChunk(messageOf(model, messageId), chunk)
      return Result.match(applied, {
        onSuccess: (message) => ({ model: updateMessage(model, messageId, () => message) }),
        onFailure: (error) =>
          commit(withNotice(model, `agent failed: ${error.message}`), messageId, OutcomeSchema.cases.Failed.make({ error: error.message })),
      })
    }
  }
}

/** The user answered for `toolCallId`: record it on the part, and run the step that carries the answer to the model. */
const respond = (
  model: ConversationModel,
  { messageId, round }: { readonly messageId: string; readonly round: number },
  toolCallId: string,
  approved: boolean,
): Return => {
  const message = messageOf(model, messageId)
  const part = toolParts(message.parts).find((part) => part.toolCallId === toolCallId)
  if (part?.state !== "approval-requested") {
    return { model }
  }
  const applied = applyChunk(message, { type: "tool-approval-response", approvalId: part.approval.id, approved })
  if (Result.isFailure(applied)) {
    return { model }
  }
  const answered = updateMessage(model, messageId, () => applied.success)
  // Every request answered: on to the step that runs (or refuses) them. Some still open: keep waiting.
  return {
    model: toolParts(applied.success.parts).some(isPendingApproval)
      ? answered
      : setTurn(answered, TurnSchema.cases.Streaming.make({ messageId, round: round + 1 })),
  }
}

const isStreaming = (model: ConversationModel, messageId: string, round: number): boolean =>
  model.turn._tag === "Streaming" && model.turn.messageId === messageId && model.turn.round === round

// UPDATE

/** Every branch checks the turn state and ids. A message that does not fit the current state leaves the Model untouched, by reference. */
export const update = (model: ConversationModel, message: Message): Return =>
  MessageSchema.match(message, {
    SubmittedPrompt: ({ text }) =>
      model.turn._tag !== "Idle" || text.trim() === ""
        ? { model }
        : {
            model: Struct.evolve(model, { turn: () => TurnSchema.cases.Accepting.make({ prompt: text }), notice: () => Option.none() }),
            commands: [AcceptPrompt({ prompt: text })],
          },
    SucceededAcceptPrompt: () => (model.turn._tag === "Accepting" ? { model: beginTurn(model, model.turn.prompt) } : { model }),
    FailedAcceptPrompt: ({ error }) =>
      model.turn._tag === "Accepting" ? { model: endTurn(withNotice(model, `could not save prompt: ${error}`)) } : { model },
    ReceivedChunk: ({ messageId, round, chunk }) =>
      isStreaming(model, messageId, round) ? receive(model, messageId, round, chunk) : { model },
    FailedStep: ({ messageId, round, error }) =>
      isStreaming(model, messageId, round)
        ? commit(withNotice(model, `agent failed: ${error}`), messageId, OutcomeSchema.cases.Failed.make({ error }))
        : { model },
    RespondedToolApproval: ({ toolCallId, approved }) =>
      model.turn._tag === "AwaitingApproval" ? respond(model, model.turn, toolCallId, approved) : { model },
    PressedEscape: () =>
      model.turn._tag === "Streaming" || model.turn._tag === "AwaitingApproval"
        ? commit(model, model.turn.messageId, OutcomeSchema.cases.Cancelled.make({}))
        : { model },
    SucceededCommitStep: () => ({ model }),
    FailedCommitStep: ({ error }) => ({ model: withNotice(model, `could not save step: ${error}`) }),
    SucceededCommitTurn: () => ({ model }),
    // The turn is already over; a failed record is a notice, whatever the conversation is doing now.
    FailedCommitTurn: ({ error }) => ({ model: withNotice(model, `could not save turn: ${error}`) }),
  })
