import { Context, Effect, FiberHandle, Layer, Option, RcMap, Ref, Scope, Semaphore } from "effect"
import type { SqlError } from "effect/sql"
import type { SessionId, SessionNotFound } from "../domain/Session.ts"
import { Turn, type TurnId, TurnInProgress, TurnNotRunning } from "../domain/Turn.ts"
import { AgentLoop } from "./AgentLoop.ts"
import { SessionStreams } from "./SessionStreams.ts"
import { TurnRepo } from "./TurnRepo.ts"

/** A runtime with no turn running and no commands in flight is stopped after this long. */
const idleTimeToLive = "5 minutes"

export interface StartTurnRequest {
  readonly turnId: TurnId
  readonly text: string
}

/**
 * One session's runtime: the only thing that runs its turns and so the only
 * writer of its stream and model log. Commands are handled one at a time.
 */
interface SessionRuntime {
  readonly startTurn: (request: StartTurnRequest) => Effect.Effect<Turn, TurnInProgress | SqlError.SqlError>
  readonly cancelTurn: Effect.Effect<void, TurnNotRunning>
}

/**
 * Session runtimes: an actor per session, started on its first command and
 * stopped once idle. The commands are what clients ask of a session; what a
 * turn does is `AgentLoop`'s.
 *
 * Whether a turn may start is decided by the database (a unique index allows
 * one running turn per session), not by the runtime's memory: a turn's row is
 * marked ended before its end reaches the stream, so a client that sees the
 * end can start the next turn straight away.
 */
export interface SessionRuntimesShape {
  /**
   * Starts a turn and returns it; its progress goes to the session's stream.
   * Starting a turn id again returns that turn instead of starting another.
   */
  readonly startTurn: (
    sessionId: SessionId,
    request: StartTurnRequest
  ) => Effect.Effect<Turn, SessionNotFound | TurnInProgress | SqlError.SqlError>
  /** Cancels the session's running turn, returning once the cancellation is recorded. */
  readonly cancelTurn: (sessionId: SessionId) => Effect.Effect<void, TurnNotRunning>
}

export class SessionRuntimes extends Context.Service<SessionRuntimes, SessionRuntimesShape>()(
  "@q/server/services/SessionRuntimes",
  {
    make: Effect.gen(function*() {
      const streams = yield* SessionStreams
      const turns = yield* TurnRepo
      const loop = yield* AgentLoop

      // Turns cut off by a restart never recorded their end; do it before running any.
      const cutOff = yield* turns.failRunning
      yield* Effect.forEach(cutOff, loop.recordCutOff, { discard: true })

      const makeRuntime = Effect.fnUntraced(function*(
        sessionId: SessionId,
        /** Holds the runtime open (for a running turn) until the scope closes. */
        retain: Effect.Effect<unknown, never, Scope.Scope>
      ) {
        const current = yield* FiberHandle.make<void, never>()
        const running = yield* Ref.make(Option.none<TurnId>())
        const oneAtATime = yield* Semaphore.make(1)

        const startTurn = Effect.fn("SessionRuntime.startTurn")(function*(request: StartTurnRequest) {
          yield* Effect.annotateCurrentSpan({ sessionId, turnId: request.turnId })
          const row = yield* Effect.orDie(Turn.insert.makeEffect({ id: request.turnId, sessionId, status: "running" }))
          const inserted = yield* turns.insert(row).pipe(
            Effect.catchReason("SqlError", "UniqueViolation", () => Effect.fail(TurnInProgress.make({ sessionId })))
          )
          if (Option.isNone(inserted)) {
            // A retry: the turn exists, so it was (or is being) run already.
            return yield* Effect.orDie(Effect.fromOption(yield* turns.findById(request.turnId)))
          }
          const turn = inserted.value
          yield* Ref.set(running, Option.some(turn.id))
          yield* FiberHandle.run(
            current,
            Effect.scoped(Effect.andThen(retain, loop.run(turn, request.text))).pipe(
              Effect.ensuring(Ref.set(running, Option.none()))
            )
          )
          return turn
        }, Semaphore.withPermit(oneAtATime))

        const cancelTurn = Effect.gen(function*() {
          yield* Effect.annotateCurrentSpan({ sessionId })
          if (Option.isNone(yield* Ref.get(running))) {
            return yield* TurnNotRunning.make({ sessionId })
          }
          return yield* FiberHandle.clear(current)
        }).pipe(Semaphore.withPermit(oneAtATime), Effect.withSpan("SessionRuntime.cancelTurn"))

        return { startTurn, cancelTurn } satisfies SessionRuntime
      })

      const runtimes: RcMap.RcMap<SessionId, SessionRuntime> = yield* RcMap.make({
        // A running turn holds its runtime through `retain`: the map is only read when it runs.
        lookup: (sessionId: SessionId) => makeRuntime(sessionId, RcMap.get(runtimes, sessionId)),
        idleTimeToLive
      })

      const startTurn = Effect.fn("SessionRuntimes.startTurn")(function*(
        sessionId: SessionId,
        request: StartTurnRequest
      ) {
        // Unknown sessions are a SessionNotFound, before a runtime is started for them.
        yield* streams.nextOffset(sessionId)
        const runtime = yield* RcMap.get(runtimes, sessionId)
        return yield* runtime.startTurn(request)
      }, Effect.scoped)

      const cancelTurn = Effect.fn("SessionRuntimes.cancelTurn")(function*(sessionId: SessionId) {
        if (!(yield* RcMap.has(runtimes, sessionId))) {
          return yield* TurnNotRunning.make({ sessionId })
        }
        const runtime = yield* RcMap.get(runtimes, sessionId)
        return yield* runtime.cancelTurn
      }, Effect.scoped)

      return { startTurn, cancelTurn } satisfies SessionRuntimesShape
    })
  }
) {
  static readonly layer = Layer.effect(SessionRuntimes, SessionRuntimes.make)
}
