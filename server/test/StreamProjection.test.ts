import { describe, it } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import { Response } from "effect/ai"
import { streamChunksOf } from "../src/domain/StreamProjection.ts"
import { output, turnId, turnStarted } from "./support/Events.ts"

const usage = Response.Usage.make({
  inputTokens: { uncached: 1, total: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined }
})

describe("StreamProjection", () => {
  it("a turn starts with the user's message, its start, and the reply's start", () => {
    deepStrictEqual(streamChunksOf(turnStarted("hi")), [
      { type: "data-user-message", id: turnId, data: { text: "hi" } },
      { type: "data-turn-start", id: turnId, data: { model: "m" } },
      { type: "start", messageId: turnId }
    ])
  })

  it("a model call's finish ends its step, not the reply", () => {
    const finish = Response.makePart("finish", { reason: "stop", usage, response: undefined })
    deepStrictEqual(streamChunksOf({ _tag: "ModelOutput", turnId, parts: [finish] }), [{ type: "finish-step" }])
  })

  it("each way a turn ends closes the reply its own way", () => {
    deepStrictEqual(streamChunksOf({ _tag: "TurnEnded", turnId, outcome: { _tag: "Completed", finishReason: "pause" } }), [
      { type: "finish", finishReason: "other" },
      { type: "data-turn-end", id: turnId, data: { reason: "completed" } }
    ])
    deepStrictEqual(streamChunksOf({ _tag: "TurnEnded", turnId, outcome: { _tag: "Cancelled" } }), [
      { type: "abort", reason: "cancelled" },
      { type: "data-turn-end", id: turnId, data: { reason: "cancelled" } }
    ])
    deepStrictEqual(streamChunksOf({ _tag: "TurnEnded", turnId, outcome: { _tag: "Failed", message: "boom" } }), [
      { type: "error", errorText: "boom" },
      { type: "data-turn-end", id: turnId, data: { reason: "failed" } }
    ])
  })

  it("is deterministic: an event always reads the same", () => {
    const event = output("a", "b")
    deepStrictEqual(streamChunksOf(event), streamChunksOf(event))
  })
})
