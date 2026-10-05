import { Match } from "effect"
import type { Response } from "effect/ai"
import type { FinishReason } from "./UiChunk.ts"
import type { StreamChunk } from "./StreamChunk.ts"

const finishReason = (reason: Response.FinishReason): FinishReason =>
  Match.value(reason).pipe(
    Match.when(Match.is("stop", "length", "content-filter", "tool-calls", "error", "other"), (same) => same),
    Match.when(Match.is("pause", "unknown"), () => "other" as const),
    Match.exhaustive
  )

const emit = (...chunks: ReadonlyArray<StreamChunk>) => chunks

/**
 * The UI message chunks a model response part becomes. One model call is one
 * step: its `finish` ends the step and the message. Parts with no
 * counterpart yet (tool parameters and approvals, files, sources, metadata)
 * are dropped; with tools, `tool-call` and `tool-result` join this match.
 * Error parts are not content: they end the turn (see `Agent`).
 */
export const uiChunksOf = (part: Exclude<Response.StreamPart<{}>, Response.ErrorPart>): ReadonlyArray<StreamChunk> =>
  Match.value(part).pipe(
    Match.discriminatorsExhaustive("type")({
      "text-start": ({ id }) => emit({ type: "text-start", id }),
      "text-delta": ({ delta, id }) => emit({ type: "text-delta", id, delta }),
      "text-end": ({ id }) => emit({ type: "text-end", id }),
      "reasoning-start": ({ id }) => emit({ type: "reasoning-start", id }),
      "reasoning-delta": ({ delta, id }) => emit({ type: "reasoning-delta", id, delta }),
      "reasoning-end": ({ id }) => emit({ type: "reasoning-end", id }),
      finish: ({ reason }) => emit({ type: "finish-step" }, { type: "finish", finishReason: finishReason(reason) }),
      "tool-params-start": () => emit(),
      "tool-params-delta": () => emit(),
      "tool-params-end": () => emit(),
      "tool-approval-request": () => emit(),
      file: () => emit(),
      source: () => emit(),
      "response-metadata": () => emit()
    })
  )
