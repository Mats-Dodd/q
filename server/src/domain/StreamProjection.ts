import { Match } from "effect"
import type { Response } from "effect/ai"
import { SessionEvent, TurnOutcome } from "./SessionEvent.ts"
import type { StreamChunk } from "./StreamChunk.ts"
import type { TurnEndReason, TurnId } from "./Turn.ts"
import type { FinishReason } from "./UiChunk.ts"

const finishReason = (reason: Response.FinishReason): FinishReason =>
  Match.value(reason).pipe(
    Match.when(Match.is("stop", "length", "content-filter", "tool-calls", "error", "other"), (same) => same),
    Match.when(Match.is("pause", "unknown"), () => "other" as const),
    Match.exhaustive
  )

const emit = (...chunks: ReadonlyArray<StreamChunk>) => chunks

/**
 * The UI chunks a model output part becomes. A model call is a step: its
 * `finish` ends the step (the message ends with the turn). Parts with no
 * counterpart yet (tool parameters and approvals, files, sources, metadata)
 * are dropped; with tools, `tool-call` and `tool-result` join this match.
 * Error parts never reach the log: they end the turn instead.
 */
const uiChunksOfPart = (part: Response.StreamPart<{}>): ReadonlyArray<StreamChunk> =>
  Match.value(part).pipe(
    Match.discriminatorsExhaustive("type")({
      "text-start": ({ id }) => emit({ type: "text-start", id }),
      "text-delta": ({ delta, id }) => emit({ type: "text-delta", id, delta }),
      "text-end": ({ id }) => emit({ type: "text-end", id }),
      "reasoning-start": ({ id }) => emit({ type: "reasoning-start", id }),
      "reasoning-delta": ({ delta, id }) => emit({ type: "reasoning-delta", id, delta }),
      "reasoning-end": ({ id }) => emit({ type: "reasoning-end", id }),
      finish: () => emit({ type: "finish-step" }),
      error: () => emit(),
      "tool-params-start": () => emit(),
      "tool-params-delta": () => emit(),
      "tool-params-end": () => emit(),
      "tool-approval-request": () => emit(),
      file: () => emit(),
      source: () => emit(),
      "response-metadata": () => emit()
    })
  )

const turnEnded = (id: TurnId, reason: TurnEndReason): StreamChunk => ({ type: "data-turn-end", id, data: { reason } })

/**
 * What clients see of an event: the session stream is this, applied to every
 * event in order. It must be deterministic (ids come from the events), since
 * the same events are projected again on every read.
 */
export const streamChunksOf = (event: SessionEvent): ReadonlyArray<StreamChunk> =>
  SessionEvent.match(event, {
    TurnStarted: ({ model, text, turnId }) =>
      emit(
        { type: "data-user-message", id: turnId, data: { text } },
        { type: "data-turn-start", id: turnId, data: { model } },
        { type: "start", messageId: turnId }
      ),
    StepStarted: () => emit({ type: "start-step" }),
    ModelOutput: ({ parts }) => parts.flatMap(uiChunksOfPart),
    TurnEnded: ({ outcome, turnId }) =>
      TurnOutcome.match(outcome, {
        Completed: ({ finishReason: reason }) =>
          emit({ type: "finish", finishReason: finishReason(reason) }, turnEnded(turnId, "completed")),
        Cancelled: () => emit({ type: "abort", reason: "cancelled" }, turnEnded(turnId, "cancelled")),
        Failed: ({ message }) => emit({ type: "error", errorText: message }, turnEnded(turnId, "failed"))
      })
  })
