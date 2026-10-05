import { Array, Cause, Context, Data, Effect, Exit, Layer, Match, Option, Ref, Result, Stream } from "effect"
import { LanguageModel, type Response } from "effect/ai"
import { SqlClient, type SqlError } from "effect/sql"
import * as ModelHistory from "../domain/ModelHistory.ts"
import type { StreamChunk } from "../domain/StreamChunk.ts"
import { Turn, type TurnEndReason, type TurnId } from "../domain/Turn.ts"
import { uiChunksOf } from "../domain/UiProjection.ts"
import { ServerConfig } from "../ServerConfig.ts"
import { ModelLog } from "./ModelLog.ts"
import { SessionRepo } from "./SessionRepo.ts"
import { SessionStreams } from "./SessionStreams.ts"
import { TurnRepo } from "./TurnRepo.ts"

/** Model output is appended in small batches: one write (and one SSE event) per batch, not per token. */
const replyBatchSize = 64
const replyBatchWindow = "30 millis"

/** What to tell the user about an error. */
const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : typeof error === "string" ? error : "The model reported an error"

/** The model reported an error mid-reply: the turn fails with it. */
class ModelError extends Data.TaggedError("ModelError")<{ readonly message: string }> {}

/** What the user is told about a failed turn: the model's error, or that something went wrong here. */
const failureText = (cause: Cause.Cause<unknown>) =>
  Option.match(Cause.findErrorOption(cause), {
    onNone: () => "The turn failed unexpectedly",
    onSome: errorText
  })

const endReasonOf = (exit: Exit.Exit<unknown, unknown>): TurnEndReason =>
  Exit.isSuccess(exit) ? "completed" : Cause.hasInterruptsOnly(exit.cause) ? "cancelled" : "failed"

/** The chunks every turn's stream ends with, by how it ended. */
const closingChunks = (id: TurnId, reason: TurnEndReason, cause: Cause.Cause<unknown>) => {
  const turnEnded: StreamChunk = { type: "data-turn-end", id, data: { reason } }
  return Match.value(reason).pipe(
    Match.when("completed", () => [turnEnded] as const),
    Match.when("cancelled", () => [{ type: "abort", reason: "cancelled" }, turnEnded] as const),
    Match.when("failed", () => [{ type: "error", errorText: failureText(cause) }, turnEnded] as const),
    Match.exhaustive
  )
}

/**
 * What a turn does: give the model the conversation and the user's message,
 * stream its reply into the session's stream, and remember it in the model
 * log. Session runtimes decide when turns run; this is the turn itself.
 */
export interface AgentLoopShape {
  /** Runs a turn to its end, recording how it ended however that was. Never fails. */
  readonly run: (turn: Turn, text: string) => Effect.Effect<void>
  /** Records the end of a turn cut off by a restart (its row is already marked failed). */
  readonly recordCutOff: (turn: Turn) => Effect.Effect<void, SqlError.SqlError>
}

export class AgentLoop extends Context.Service<AgentLoop, AgentLoopShape>()("@q/server/services/AgentLoop", {
  make: Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const streams = yield* SessionStreams
    const modelLog = yield* ModelLog
    const sessions = yield* SessionRepo
    const turns = yield* TurnRepo
    const model = yield* LanguageModel.LanguageModel
    const config = yield* ServerConfig

    /** Appends a batch of the reply, then fails if the model failed. */
    const appendReply = Effect.fnUntraced(function*<E>(
      turn: Turn,
      batch: ReadonlyArray<Result.Result<ReadonlyArray<StreamChunk>, E>>
    ) {
      const said = Array.flatMap(Array.takeWhile(batch, Result.isSuccess), Result.getOrElse(() => []))
      if (Array.isReadonlyArrayNonEmpty(said)) {
        yield* streams.append(turn.sessionId, said)
      }
      return yield* Option.match(Array.findFirst(batch, Result.isFailure), {
        onNone: () => Effect.void,
        onSome: (failed) => Effect.fail(failed.failure)
      })
    })

    const runTurn = Effect.fnUntraced(function*(
      turn: Turn,
      text: string,
      parts: Ref.Ref<ReadonlyArray<Response.StreamPart<{}>>>
    ) {
      yield* sql.withTransaction(Effect.gen(function*() {
        yield* modelLog.append(turn.sessionId, turn.id, [ModelHistory.userMessage(text)])
        yield* sessions.touch(turn.sessionId)
        yield* streams.append(turn.sessionId, [
          { type: "data-user-message", id: turn.id, data: { text } },
          { type: "data-turn-start", id: turn.id, data: { model: config.model } }
        ])
      }))
      const prompt = yield* modelLog.history(turn.sessionId)
      yield* streams.append(turn.sessionId, [{ type: "start", messageId: turn.id }, { type: "start-step" }])
      yield* model.streamText({ prompt }).pipe(
        Stream.tap((part) => Ref.update(parts, Array.append(part))),
        Stream.mapEffect((part) =>
          part.type === "error"
            ? Effect.fail(new ModelError({ message: errorText(part.error) }))
            : Effect.succeed(uiChunksOf(part))
        ),
        // A failure becomes the last element, so what was said before it is still written.
        Stream.result,
        Stream.groupedWithin(replyBatchSize, replyBatchWindow),
        Stream.runForEach((batch) => appendReply(turn, batch))
      )
    })

    /**
     * Records how a turn ended, in one transaction: its row first (so a client
     * that sees the end in the stream can start the next turn straight away),
     * what the model said in the model log, and the stream's closing chunks.
     * Never fails: there is no one left to tell.
     */
    const recordTurnEnd = Effect.fn("AgentLoop.recordTurnEnd")(function*(
      turn: Turn,
      exit: Exit.Exit<unknown, unknown>,
      parts: ReadonlyArray<Response.StreamPart<{}>>
    ) {
      const reason = endReasonOf(exit)
      yield* Effect.annotateCurrentSpan({ sessionId: turn.sessionId, turnId: turn.id, reason })
      if (Exit.isFailure(exit) && reason === "failed") {
        yield* Effect.logWarning("turn failed", exit.cause)
      }
      const row = yield* Effect.orDie(Turn.update.makeEffect({ id: turn.id, sessionId: turn.sessionId, status: reason }))
      const reply = ModelHistory.replyMessages(parts)
      yield* sql.withTransaction(Effect.gen(function*() {
        yield* turns.finish(row)
        if (Array.isReadonlyArrayNonEmpty(reply)) {
          yield* modelLog.append(turn.sessionId, turn.id, reply)
        }
        yield* streams.append(
          turn.sessionId,
          closingChunks(turn.id, reason, Exit.isFailure(exit) ? exit.cause : Cause.empty)
        )
      }))
    }, Effect.catchCause((cause) => Effect.logError("could not record the end of a turn", cause)))

    const run = Effect.fn("AgentLoop.run")(function*(turn: Turn, text: string) {
      yield* Effect.annotateCurrentSpan({ sessionId: turn.sessionId, turnId: turn.id })
      const parts = yield* Ref.make<ReadonlyArray<Response.StreamPart<{}>>>([])
      yield* runTurn(turn, text, parts).pipe(
        Effect.onExit((exit) => Ref.get(parts).pipe(Effect.flatMap((said) => recordTurnEnd(turn, exit, said)))),
        Effect.ignore
      )
    })

    const recordCutOff = Effect.fn("AgentLoop.recordCutOff")(function*(turn: Turn) {
      yield* Effect.annotateCurrentSpan({ sessionId: turn.sessionId, turnId: turn.id })
      yield* streams.append(
        turn.sessionId,
        closingChunks(turn.id, "failed", Cause.fail(new Error("The server stopped during this turn")))
      )
    })

    return { run, recordCutOff } satisfies AgentLoopShape
  })
}) {
  static readonly layer = Layer.effect(AgentLoop, AgentLoop.make)
}
