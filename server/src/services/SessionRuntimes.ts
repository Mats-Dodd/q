import {
  Array,
  Cause,
  Context,
  Crypto,
  Effect,
  Exit,
  FiberHandle,
  Layer,
  Option,
  RcMap,
  Ref,
  Result,
  type Scope,
  Semaphore,
  Stream
} from "effect"
import { Prompt } from "effect/ai"
import type { SqlError } from "effect/sql"
import { type AgentOutput, eventsOf } from "../domain/AgentOutput.ts"
import type { SessionId, SessionNotFound } from "../domain/Session.ts"
import type { SessionEvent, TurnOutcome } from "../domain/SessionEvent.ts"
import * as SessionState from "../domain/SessionState.ts"
import { type Delivery, type MessageId, NothingToCancel, type SessionBusy, TurnId } from "../domain/Turn.ts"
import { ServerConfig } from "../ServerConfig.ts"
import { AgentLoop, errorText } from "./AgentLoop.ts"
import { SessionEventLog } from "./SessionEventLog.ts"

/** A runtime with no turn running and no commands in flight is stopped after this long. */
const idleTimeToLive = "5 minutes"

/** The agent's output is recorded in small batches: one append (and one SSE event) per batch, not per token. */
const outputBatchSize = 64
const outputBatchWindow = "30 millis"

export interface SendMessage {
  readonly messageId: MessageId
  readonly text: string
}

/** A decision `transact` carries out: the events to append, and what to return. */
const decided = <A>(events: ReadonlyArray<SessionEvent>, result: A): readonly [ReadonlyArray<SessionEvent>, A] => [
  events,
  result
]

/** What the user is told about a failed turn: the model's error, or that something went wrong here. */
const failureText = (cause: Cause.Cause<unknown>) =>
  Option.match(Cause.findErrorOption(cause), {
    onNone: () => "The turn failed unexpectedly",
    onSome: errorText
  })

/** How a turn that exited with `exit` ended. */
const outcomeOf = (exit: Exit.Exit<unknown, unknown>, state: SessionState.SessionState): TurnOutcome => {
  if (Exit.isSuccess(exit)) {
    const finishReason = Option.flatMap(state.running, SessionState.lastFinishReason)
    return { _tag: "Completed", finishReason: Option.getOrElse(finishReason, () => "other" as const) }
  }
  return Cause.hasInterruptsOnly(exit.cause)
    ? { _tag: "Cancelled" }
    : { _tag: "Failed", message: failureText(exit.cause) }
}

/**
 * One session's runtime: it holds the session's state (its events, folded) and
 * is the only thing that appends to its log. Commands are handled one at a
 * time; the running turn is a child fiber.
 */
interface SessionRuntime {
  readonly sendMessage: (message: SendMessage) => Effect.Effect<Delivery, SessionBusy | SqlError.SqlError>
  readonly cancel: Effect.Effect<void, NothingToCancel>
}

/**
 * Session runtimes: an actor per session, started on its first command (from
 * its events) and stopped once idle; a running turn holds its runtime open.
 */
export interface SessionRuntimesShape {
  /** Sends a message: it starts a turn, whose progress goes to the session's stream. Resending it is a no-op. */
  readonly sendMessage: (
    sessionId: SessionId,
    message: SendMessage
  ) => Effect.Effect<Delivery, SessionNotFound | SessionBusy | SqlError.SqlError>
  /** Cancels the running turn, returning once the cancellation is recorded. */
  readonly cancel: (sessionId: SessionId) => Effect.Effect<void, NothingToCancel>
}

export class SessionRuntimes extends Context.Service<SessionRuntimes, SessionRuntimesShape>()(
  "@q/server/services/SessionRuntimes",
  {
    make: Effect.gen(function*() {
      const log = yield* SessionEventLog
      const loop = yield* AgentLoop
      const crypto = yield* Crypto.Crypto
      const { model } = yield* ServerConfig

      const makeRuntime = Effect.fnUntraced(function*(
        sessionId: SessionId,
        /** Holds the runtime open (for a running turn) until the scope closes. */
        retain: Effect.Effect<unknown, never, Scope.Scope>
      ) {
        const stored = yield* log.readFrom(sessionId, 0)
        const state = yield* Ref.make(SessionState.replay(Array.map(stored, (event) => event.event)))
        const appending = yield* Semaphore.make(1)
        const commanding = yield* Semaphore.make(1)
        const current = yield* FiberHandle.make<void, never>()

        /**
         * The only way the session changes: decide events from the current state,
         * append them (checked against its version), fold them in. One at a time,
         * and uninterruptible once deciding is done, so the log and the state never
         * disagree (cancelling a turn cannot land between the two).
         */
        const transact = <A, E>(
          decide: (state: SessionState.SessionState) => Result.Result<readonly [ReadonlyArray<SessionEvent>, A], E>
        ) =>
          Effect.gen(function*() {
            const before = yield* Ref.get(state)
            const [events, result] = yield* Effect.fromResult(decide(before))
            if (Array.isReadonlyArrayNonEmpty(events)) {
              yield* log.append(sessionId, before.version, events).pipe(
                Effect.flatMap((appended) =>
                  Ref.set(state, Array.reduce(appended, before, (s, { event }) => SessionState.evolve(s, event)))
                ),
                Effect.uninterruptible
              )
            }
            return result
          }).pipe(
            // Only this runtime appends, so a conflict means the log changed underneath it: a bug.
            Effect.catchTag("VersionConflict", Effect.die),
            Semaphore.withPermit(appending)
          )

        /** Appends a batch of the agent's output, then fails if the agent failed. */
        const recordOutput = Effect.fnUntraced(function*<E>(
          turnId: TurnId,
          batch: ReadonlyArray<Result.Result<AgentOutput, E>>
        ) {
          const produced = Array.getSuccesses(Array.takeWhile(batch, Result.isSuccess))
          yield* transact(() => Result.succeed(decided(eventsOf(produced, turnId), undefined)))
          return yield* Option.match(Array.findFirst(batch, Result.isFailure), {
            onNone: () => Effect.void,
            onSome: (failed) => Effect.fail(failed.failure)
          })
        })

        /** Records how the turn ended. Never fails: there is no one left to tell. */
        const recordEnd = (turnId: TurnId, exit: Exit.Exit<unknown, unknown>) =>
          transact((s) => Result.succeed(decided([{ _tag: "TurnEnded", turnId, outcome: outcomeOf(exit, s) }], undefined))).pipe(
            Effect.tap(() =>
              Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
                ? Effect.logWarning("turn failed", exit.cause)
                : Effect.void
            ),
            Effect.catchCause((cause) => Effect.logError("could not record the end of a turn", cause))
          )

        const runTurn = (turnId: TurnId) =>
          Effect.gen(function*() {
            const history = Prompt.fromMessages((yield* Ref.get(state)).history)
            yield* loop.run(history).pipe(
              // A failure becomes the last element, so what was produced before it is still recorded.
              Stream.result,
              Stream.groupedWithin(outputBatchSize, outputBatchWindow),
              Stream.runForEach((batch) => recordOutput(turnId, batch))
            )
          }).pipe(
            Effect.onExit((exit) => recordEnd(turnId, exit)),
            Effect.ignore,
            Effect.withSpan("SessionRuntime.runTurn", { attributes: { sessionId, turnId } })
          )

        // A turn cut off by a restart never recorded its end; do it before anything else.
        const recovered = yield* Ref.get(state)
        if (Option.isSome(recovered.running)) {
          const { turnId } = recovered.running.value
          yield* transact(() =>
            Result.succeed(decided([{
              _tag: "TurnEnded",
              turnId,
              outcome: { _tag: "Failed", message: "The server stopped during this turn" }
            }], undefined))
          )
        }

        const sendMessage = Effect.fn("SessionRuntime.sendMessage")(function*(message: SendMessage) {
          yield* Effect.annotateCurrentSpan({ sessionId, messageId: message.messageId })
          const turnId = TurnId.make(yield* Effect.orDie(crypto.randomUUIDv7))
          const decision = yield* transact<{ readonly turnId: TurnId; readonly start: boolean }, SessionBusy>((s) =>
            SessionState.decideSend(s, { sessionId, ...message, turnId, model }).pipe(
              Result.map((choice) =>
                SessionState.SendDecision.$match(choice, {
                  AlreadyDelivered: (delivered) => decided([], { turnId: delivered.turnId, start: false }),
                  Start: ({ event }) => decided([event], { turnId: event.turnId, start: true })
                })
              )
            )
          )
          if (decision.start) {
            yield* FiberHandle.run(current, Effect.scoped(Effect.andThen(retain, runTurn(decision.turnId))))
          }
          return { turnId: decision.turnId, disposition: "started" } satisfies Delivery
        }, Semaphore.withPermit(commanding))

        const cancel = Effect.gen(function*() {
          if (Option.isNone((yield* Ref.get(state)).running)) {
            return yield* NothingToCancel.make({ sessionId })
          }
          return yield* FiberHandle.clear(current)
        }).pipe(Semaphore.withPermit(commanding), Effect.withSpan("SessionRuntime.cancel", { attributes: { sessionId } }))

        return { sendMessage, cancel } satisfies SessionRuntime
      })

      const runtimes: RcMap.RcMap<SessionId, SessionRuntime, SqlError.SqlError> = yield* RcMap.make({
        // A running turn holds its runtime through `retain`: the map is only read when it runs.
        lookup: (sessionId: SessionId) => makeRuntime(sessionId, RcMap.get(runtimes, sessionId).pipe(Effect.ignore)),
        idleTimeToLive
      })

      // Sessions whose turn was cut off by a restart: opening their runtime records it.
      const unfinished = yield* log.withUnfinishedTurns
      yield* Effect.forEach(unfinished, (sessionId) => Effect.scoped(RcMap.get(runtimes, sessionId)), { discard: true })

      const sendMessage = Effect.fn("SessionRuntimes.sendMessage")(function*(
        sessionId: SessionId,
        message: SendMessage
      ) {
        // Unknown sessions are a SessionNotFound, before a runtime is started for them.
        yield* log.nextSeq(sessionId)
        const runtime = yield* RcMap.get(runtimes, sessionId)
        return yield* runtime.sendMessage(message)
      }, Effect.scoped)

      const cancel = Effect.fn("SessionRuntimes.cancel")(function*(sessionId: SessionId) {
        if (!(yield* RcMap.has(runtimes, sessionId))) {
          return yield* NothingToCancel.make({ sessionId })
        }
        const runtime = yield* RcMap.get(runtimes, sessionId).pipe(
          Effect.catchTag("SqlError", () => Effect.fail(NothingToCancel.make({ sessionId })))
        )
        return yield* runtime.cancel
      }, Effect.scoped)

      return { sendMessage, cancel } satisfies SessionRuntimesShape
    })
  }
) {
  static readonly layer = Layer.effect(SessionRuntimes, SessionRuntimes.make)
}
