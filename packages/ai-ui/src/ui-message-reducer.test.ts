import { assert, describe, it } from "@effect/vitest"
import { Effect, Result, Stream } from "effect"

import type { UIMessage } from "./ui-message"
import type { UIMessageChunk } from "./ui-message-chunk"
import { applyChunk, emptyAssistant, finalize, foldUIMessageStream, readUIMessageStream } from "./ui-message-reducer"
import type { WeatherToolkit } from "./weather.fixture"

// The reducer, chunk by chunk. A message is the whole state; nothing lives beside it.

type Tools = typeof WeatherToolkit.tools
type Chunk = UIMessageChunk<Tools>
type Message = UIMessage<Tools>

const fold = (message: Message, chunks: ReadonlyArray<Chunk>): Message =>
  chunks.reduce((m, chunk) => Result.getOrThrow(applyChunk(m, chunk)), message)

const assertFailure = (message: Message, chunk: Chunk) => {
  const result = applyChunk(message, chunk)
  return Result.isFailure(result)
    ? result.failure
    : assert.fail(`expected a UIMessageStreamError, got a message with ${result.success.parts.length} parts`)
}

const start = emptyAssistant<Tools>("m1")

describe("text", () => {
  it("start, deltas and end build one done text part, by id", () => {
    const m = fold(start, [
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "he" },
      { type: "text-delta", id: "t", delta: "llo" },
      { type: "text-end", id: "t" },
    ])
    assert.deepStrictEqual(m.parts, [{ type: "text", id: "t", text: "hello", state: "done" }])
  })

  it("two text streams interleave by id", () => {
    const m = fold(start, [
      { type: "text-start", id: "a" },
      { type: "text-start", id: "b" },
      { type: "text-delta", id: "b", delta: "B" },
      { type: "text-delta", id: "a", delta: "A" },
    ])
    assert.deepStrictEqual(
      m.parts.map((p) => (p.type === "text" ? p.text : "?")),
      ["A", "B"],
    )
  })

  it("a delta or end without a start is a UIMessageStreamError", () => {
    const error = assertFailure(start, { type: "text-delta", id: "t", delta: "x" })
    assert.strictEqual(error._tag, "UIMessageStreamError")
    assert.strictEqual(error.chunkType, "text-delta")
    assert.strictEqual(error.chunkId, "t")
    assertFailure(start, { type: "text-end", id: "t" })
    assertFailure(start, { type: "reasoning-delta", id: "r", delta: "x" })
  })

  it("a delta after the end does not reopen the part", () => {
    const done = fold(start, [
      { type: "text-start", id: "t" },
      { type: "text-end", id: "t" },
    ])
    assertFailure(done, { type: "text-delta", id: "t", delta: "late" })
  })

  it("chunks that carry no state leave the message unchanged by reference", () => {
    for (const chunk of [{ type: "finish-step" }, { type: "finish" }, { type: "error", errorText: "x" }, { type: "abort" }] as const) {
      assert.strictEqual(Result.getOrThrow(applyChunk(start, chunk)), start)
    }
  })

  it("start-step is a step-start part; start with a messageId renames the message", () => {
    const m = fold(start, [{ type: "start", messageId: "server-id" }, { type: "start-step" }])
    assert.strictEqual(m.id, "server-id")
    assert.deepStrictEqual(m.parts, [{ type: "step-start" }])
  })
})

describe("tool calls", () => {
  const streaming: Chunk = { type: "tool-input-start", toolCallId: "c1", toolName: "get_weather" }
  const available: Chunk = { type: "tool-input-available", toolCallId: "c1", toolName: "get_weather", input: { city: "Oslo" } }
  const output: Chunk = { type: "tool-output-available", toolCallId: "c1", output: { temperatureC: 3, sky: "grey" } }

  it("input-start, input-available, output-available is the happy path, in one part", () => {
    const m = fold(start, [streaming, { type: "tool-input-delta", toolCallId: "c1", inputTextDelta: '{"city"' }, available, output])
    assert.deepStrictEqual(m.parts, [
      {
        type: "tool-get_weather",
        toolCallId: "c1",
        state: "output-available",
        input: { city: "Oslo" },
        output: { temperatureC: 3, sky: "grey" },
      },
    ])
    const part = m.parts[0]
    if (part?.type === "tool-get_weather" && part.state === "output-available") {
      const temperature: number = part.output.temperatureC
      assert.strictEqual(temperature, 3)
    }
  })

  it("input-available without an input-start creates the part", () => {
    assert.deepStrictEqual(fold(start, [available]).parts, [
      { type: "tool-get_weather", toolCallId: "c1", state: "input-available", input: { city: "Oslo" } },
    ])
  })

  it("an input error is output-error with the raw input", () => {
    const m = fold(start, [
      streaming,
      { type: "tool-input-error", toolCallId: "c1", toolName: "get_weather", input: { town: 1 }, errorText: "bad" },
    ])
    assert.deepStrictEqual(m.parts, [
      { type: "tool-get_weather", toolCallId: "c1", state: "output-error", input: { town: 1 }, errorText: "bad" },
    ])
  })

  it("an output error keeps the input", () => {
    const m = fold(start, [available, { type: "tool-output-error", toolCallId: "c1", errorText: "boom" }])
    assert.deepStrictEqual(m.parts, [
      { type: "tool-get_weather", toolCallId: "c1", state: "output-error", input: { city: "Oslo" }, errorText: "boom" },
    ])
  })

  it("a dynamic call is a dynamic-tool part with its name", () => {
    const m = fold(start, [
      { type: "tool-input-start", toolCallId: "d", toolName: "made_up", dynamic: true },
      { type: "tool-input-available", toolCallId: "d", toolName: "made_up", dynamic: true, input: 1 },
      { type: "tool-output-available", toolCallId: "d", dynamic: true, output: "one" },
    ])
    assert.deepStrictEqual(m.parts, [
      { type: "dynamic-tool", toolName: "made_up", toolCallId: "d", state: "output-available", input: 1, output: "one" },
    ])
  })

  it("outputs, deltas and approvals for an unknown call are UIMessageStreamErrors", () => {
    assertFailure(start, output)
    assertFailure(start, { type: "tool-output-error", toolCallId: "c1", errorText: "x" })
    assertFailure(start, { type: "tool-output-denied", toolCallId: "c1" })
    assertFailure(start, { type: "tool-input-delta", toolCallId: "c1", inputTextDelta: "x" })
    assertFailure(start, { type: "tool-approval-request", approvalId: "a", toolCallId: "c1" })
    assertFailure(start, { type: "tool-approval-response", approvalId: "a", approved: true })
  })

  it("approval: requested, responded, then the output; a denial ends in output-denied", () => {
    const requested = fold(start, [available, { type: "tool-approval-request", approvalId: "a1", toolCallId: "c1" }])
    assert.deepStrictEqual(requested.parts, [
      { type: "tool-get_weather", toolCallId: "c1", state: "approval-requested", input: { city: "Oslo" }, approval: { id: "a1" } },
    ])

    const approved = fold(requested, [{ type: "tool-approval-response", approvalId: "a1", approved: true }, output])
    assert.deepStrictEqual(approved.parts, [
      {
        type: "tool-get_weather",
        toolCallId: "c1",
        state: "output-available",
        input: { city: "Oslo" },
        output: { temperatureC: 3, sky: "grey" },
        approval: { id: "a1", approved: true },
      },
    ])

    const denied = fold(requested, [
      { type: "tool-approval-response", approvalId: "a1", approved: false, reason: "no" },
      { type: "tool-output-denied", toolCallId: "c1" },
    ])
    assert.deepStrictEqual(denied.parts, [
      {
        type: "tool-get_weather",
        toolCallId: "c1",
        state: "output-denied",
        input: { city: "Oslo" },
        approval: { id: "a1", approved: false, reason: "no" },
      },
    ])
  })

  it("an approval request for a part that has no input yet is an error", () => {
    assertFailure(fold(start, [streaming]), { type: "tool-approval-request", approvalId: "a1", toolCallId: "c1" })
  })
})

describe("finalize", () => {
  it("closes streaming text and reasoning; a closed message is unchanged by reference", () => {
    const open = fold(start, [
      { type: "reasoning-start", id: "r" },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "pa" },
    ])
    const closed = finalize(open)
    assert.deepStrictEqual(closed.parts, [
      { type: "reasoning", id: "r", text: "", state: "done" },
      { type: "text", id: "t", text: "pa", state: "done" },
    ])
    assert.strictEqual(finalize(closed), closed)
  })
})

describe("streams", () => {
  const chunks: ReadonlyArray<Chunk> = [
    { type: "start-step" },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: "hi" },
    { type: "text-end", id: "t" },
    { type: "finish-step" },
  ]

  it.effect("readUIMessageStream is the message after each chunk", () =>
    Effect.gen(function* () {
      const messages = yield* Stream.runCollect(readUIMessageStream(Stream.fromIterable(chunks), start))
      assert.strictEqual(messages.length, chunks.length)
      assert.deepStrictEqual(messages.at(-1)?.parts, [{ type: "step-start" }, { type: "text", id: "t", text: "hi", state: "done" }])
    }),
  )

  it.effect("a chunk that does not fit fails the stream", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        Stream.runCollect(readUIMessageStream(Stream.make<Array<Chunk>>({ type: "text-end", id: "t" }), start)),
      )
      assert.strictEqual(error._tag, "UIMessageStreamError")
    }),
  )

  it.effect("foldUIMessageStream is the finalized last message; an empty stream is the initial one", () =>
    Effect.gen(function* () {
      const cut = yield* foldUIMessageStream(Stream.fromIterable(chunks.slice(0, 3)), start)
      assert.deepStrictEqual(cut.parts, [{ type: "step-start" }, { type: "text", id: "t", text: "hi", state: "done" }])
      assert.strictEqual(yield* foldUIMessageStream(Stream.empty, start), start)
    }),
  )
})
