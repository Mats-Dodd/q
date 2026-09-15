import { assert, it } from "@effect/vitest"
import { Effect, Stream } from "effect"

import { DONE, encodeChunk, fromSseStream, toSseStream } from "./sse"
import type { UIMessageChunk } from "./ui-message-chunk"
import { WeatherToolkit } from "./weather.fixture"

type Chunk = UIMessageChunk<typeof WeatherToolkit.tools>

const chunks: ReadonlyArray<Chunk> = [
  { type: "start-step" },
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: "hi\nthere" },
  { type: "tool-input-available", toolCallId: "c", toolName: "get_weather", input: { city: "Oslo" } },
  { type: "tool-output-available", toolCallId: "c", output: { temperatureC: 3, sky: "grey" } },
  { type: "finish-step" },
]

it("a chunk is one data line and a blank line", () => {
  assert.strictEqual(encodeChunk({ type: "start-step" }), 'data: {"type":"start-step"}\n\n')
  assert.strictEqual(DONE, "data: [DONE]\n\n")
})

it.effect("chunks go to bytes and back, and the stream ends at [DONE]", () =>
  Effect.gen(function* () {
    const bytes = yield* Stream.runCollect(toSseStream(Stream.fromIterable(chunks)))
    const text = new TextDecoder().decode(Buffer.concat(bytes))
    assert.isTrue(text.endsWith(DONE))

    // Re-chunk the bytes at odd boundaries: a socket does not respect event boundaries.
    const all = Buffer.concat(bytes)
    const pieces = [all.subarray(0, 7), all.subarray(7, 40), all.subarray(40)]
    const decoded = yield* Stream.runCollect(fromSseStream(WeatherToolkit)(Stream.fromIterable(pieces)))
    assert.deepStrictEqual(decoded, chunks)
  }),
)

it.effect("a chunk that does not fit the toolkit fails decoding", () =>
  Effect.gen(function* () {
    const bytes = new TextEncoder().encode('data: {"type":"tool-input-available","toolCallId":"c","toolName":"get_weather","input":{}}\n\n')
    const exit = yield* Effect.exit(Stream.runCollect(fromSseStream(WeatherToolkit)(Stream.make(bytes))))
    assert.strictEqual(exit._tag, "Failure")
  }),
)
