import { Array, Data, Function, HashMap, Option, Result } from "effect"
import type { Prompt, Response } from "effect/ai"
import * as ModelHistory from "./ModelHistory.ts"
import type { SessionId } from "./Session.ts"
import { SessionEvent, type TurnStarted } from "./SessionEvent.ts"
import { type MessageId, SessionBusy, type TurnId } from "./Turn.ts"

/**
 * A session's state: what its events add up to. `evolve` is how an event
 * changes it, `decide` what a command does to it. Both are pure; the session's
 * runtime holds the state and appends the events.
 */

export interface RunningTurn {
  readonly turnId: TurnId
  /** The model's output so far, across its steps. */
  readonly parts: ReadonlyArray<Response.StreamPart<{}>>
}

export interface SessionState {
  /** How many events there are: the seq the next one gets, which appends are checked against. */
  readonly version: number
  /** Every message delivered so far, and the turn it started. */
  readonly delivered: HashMap.HashMap<MessageId, TurnId>
  readonly running: Option.Option<RunningTurn>
  /** The conversation as the model sees it: what the next turn is prompted with. */
  readonly history: ReadonlyArray<Prompt.Message>
}

export const empty: SessionState = {
  version: 0,
  delivered: HashMap.empty(),
  running: Option.none(),
  history: []
}

const withRunning = (state: SessionState, f: (turn: RunningTurn) => RunningTurn): SessionState => ({
  ...state,
  running: Option.map(state.running, f)
})

export const evolve: {
  (event: SessionEvent): (state: SessionState) => SessionState
  (state: SessionState, event: SessionEvent): SessionState
} = Function.dual(2, (state: SessionState, event: SessionEvent): SessionState => {
  const next = SessionEvent.match(event, {
    TurnStarted: ({ messageId, text, turnId }) => ({
      ...state,
      delivered: HashMap.set(state.delivered, messageId, turnId),
      running: Option.some({ turnId, parts: [] }),
      history: [...state.history, ModelHistory.userMessage(text)]
    }),
    StepStarted: () => state,
    ModelOutput: ({ parts }) => withRunning(state, (turn) => ({ ...turn, parts: [...turn.parts, ...parts] })),
    TurnEnded: () => ({
      ...state,
      running: Option.none(),
      history: Option.match(state.running, {
        onNone: () => state.history,
        onSome: (turn) => [...state.history, ...ModelHistory.replyMessages(turn.parts)]
      })
    })
  })
  return { ...next, version: state.version + 1 }
})

export const replay = (events: Iterable<SessionEvent>): SessionState =>
  Array.reduce(events, empty, (state, event) => evolve(state, event))

/** Why the running turn's last model call stopped, if it has finished one. */
export const lastFinishReason = (turn: RunningTurn): Option.Option<Response.FinishReason> =>
  Array.findLast(turn.parts, (part) => part.type === "finish").pipe(
    Option.flatMap((part) => part.type === "finish" ? Option.some(part.reason) : Option.none())
  )

export type SendDecision = Data.TaggedEnum<{
  /** This message was sent before: it started this turn. */
  AlreadyDelivered: { readonly turnId: TurnId }
  /** It starts a turn. */
  Start: { readonly event: typeof TurnStarted.Type }
}>
export const SendDecision = Data.taggedEnum<SendDecision>()

/** A message to send, and what its turn would be if it starts one. */
export interface Send {
  readonly sessionId: SessionId
  readonly messageId: MessageId
  readonly text: string
  /** The id the turn gets if one starts (ids are chosen outside, to keep this pure). */
  readonly turnId: TurnId
  readonly model: string
}

/** What sending a message does: start a turn, unless one is running (or it was already sent). */
export const decideSend: {
  (send: Send): (state: SessionState) => Result.Result<SendDecision, SessionBusy>
  (state: SessionState, send: Send): Result.Result<SendDecision, SessionBusy>
} = Function.dual(2, (state: SessionState, send: Send): Result.Result<SendDecision, SessionBusy> =>
  Option.match(HashMap.get(state.delivered, send.messageId), {
    onSome: (turnId) => Result.succeed(SendDecision.AlreadyDelivered({ turnId })),
    onNone: () =>
      Option.isSome(state.running)
        ? Result.fail(SessionBusy.make({ sessionId: send.sessionId }))
        : Result.succeed(SendDecision.Start({
          event: { _tag: "TurnStarted", turnId: send.turnId, messageId: send.messageId, text: send.text, model: send.model }
        }))
  }))
