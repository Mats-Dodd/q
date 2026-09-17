import { assert, describe, it } from "@effect/vitest"
import { Effect, Option, Stream } from "effect"
import { Response } from "effect/unstable/ai"

import { toUIMessageChunk, toUIMessageStream } from "./ui-message-stream"
import { WeatherToolkit } from "./weather.fixture"

// The adapter, one Effect part at a time. What it emits is what `useChat` would receive.

const convert = toUIMessageChunk(WeatherToolkit)
const chunkOf = (part: Parameters<typeof convert>[0]) => Option.getOrThrow(convert(part))
const assertNone = (part: Parameters<typeof convert>[0]) => assert.isTrue(Option.isNone(convert(part)))
const errorTextOf = (chunk: ReturnType<typeof chunkOf>): string =>
  chunk.type === "tool-output-error" ? chunk.errorText : assert.fail(`expected tool-output-error, got ${chunk.type}`)

describe("text and reasoning", () => {
  it("text parts map one to one, and empty metadata is dropped", () => {
    assert.deepStrictEqual(chunkOf(Response.makePart("text-start", { id: "t" })), { type: "text-start", id: "t" })
    assert.deepStrictEqual(chunkOf(Response.makePart("text-delta", { id: "t", delta: "hi" })), { type: "text-delta", id: "t", delta: "hi" })
    assert.deepStrictEqual(chunkOf(Response.makePart("text-end", { id: "t" })), { type: "text-end", id: "t" })
  })

  it("provider metadata travels as providerMetadata", () => {
    assert.deepStrictEqual(chunkOf(Response.makePart("reasoning-start", { id: "r", metadata: { acme: { signature: "s" } } })), {
      type: "reasoning-start",
      id: "r",
      providerMetadata: { acme: { signature: "s" } },
    })
  })

  it("reasoning is dropped when sendReasoning is false", () => {
    const quiet = toUIMessageChunk(WeatherToolkit, { sendReasoning: false })
    assert.isTrue(Option.isNone(quiet(Response.makePart("reasoning-delta", { id: "r", delta: "hm" }))))
  })
})

describe("tool calls", () => {
  it("a call with valid parameters is a typed tool-input-available", () => {
    const chunk = chunkOf(
      Response.makePart("tool-call", { id: "c1", name: "get_weather", params: { city: "Oslo" }, providerExecuted: false }),
    )
    assert.deepStrictEqual(chunk, { type: "tool-input-available", toolCallId: "c1", toolName: "get_weather", input: { city: "Oslo" } })
    if (chunk.type === "tool-input-available" && chunk.dynamic !== true && chunk.toolName === "get_weather") {
      const city: string = chunk.input.city
      assert.strictEqual(city, "Oslo")
    }
  })

  it("a call with invalid parameters is a tool-input-error that keeps the raw input", () => {
    const chunk = chunkOf(
      Response.makePart("tool-call", { id: "c1", name: "get_weather", params: { town: "Oslo" }, providerExecuted: false }),
    )
    assert.strictEqual(chunk.type, "tool-input-error")
    if (chunk.type === "tool-input-error") {
      assert.deepStrictEqual(chunk.input, { town: "Oslo" })
      assert.include(chunk.errorText, "city")
    }
  })

  it("a call to a tool the toolkit does not know is dynamic", () => {
    assert.deepStrictEqual(chunkOf(Response.makePart("tool-params-start", { id: "c2", name: "made_up", providerExecuted: false })), {
      type: "tool-input-start",
      toolCallId: "c2",
      toolName: "made_up",
      dynamic: true,
    })
    assert.deepStrictEqual(chunkOf(Response.makePart("tool-call", { id: "c2", name: "made_up", params: 1, providerExecuted: false })), {
      type: "tool-input-available",
      toolCallId: "c2",
      toolName: "made_up",
      dynamic: true,
      input: 1,
    })
  })

  it("parameter deltas are tool-input-delta; the end of the parameters is nothing", () => {
    assert.deepStrictEqual(chunkOf(Response.makePart("tool-params-delta", { id: "c1", delta: '{"ci' })), {
      type: "tool-input-delta",
      toolCallId: "c1",
      inputTextDelta: '{"ci',
    })
    assertNone(Response.makePart("tool-params-end", { id: "c1" }))
  })
})

describe("tool results", () => {
  const result = (isFailure: boolean, encodedResult: unknown, preliminary = false) =>
    Response.makePart("tool-result", {
      id: "c1",
      name: "get_weather",
      isFailure,
      result: encodedResult,
      encodedResult,
      providerExecuted: false,
      preliminary,
    })

  it("a success is tool-output-available with the encoded result", () => {
    assert.deepStrictEqual(chunkOf(result(false, { temperatureC: 3, sky: "grey" })), {
      type: "tool-output-available",
      toolCallId: "c1",
      output: { temperatureC: 3, sky: "grey" },
    })
  })

  it("a preliminary success is marked; a preliminary failure is nothing", () => {
    assert.deepStrictEqual(chunkOf(result(false, { temperatureC: 3, sky: "grey" }, true)), {
      type: "tool-output-available",
      toolCallId: "c1",
      output: { temperatureC: 3, sky: "grey" },
      preliminary: true,
    })
    assertNone(result(true, { unknownCity: "x" }, true))
  })

  it("a failure is tool-output-error with a one-line description", () => {
    assert.deepStrictEqual(chunkOf(result(true, { unknownCity: "Atlantis" })), {
      type: "tool-output-error",
      toolCallId: "c1",
      errorText: '{"unknownCity":"Atlantis"}',
    })
    assert.strictEqual(errorTextOf(chunkOf(result(true, { message: "boom" }))), "boom")
    assert.strictEqual(errorTextOf(chunkOf(result(true, "plain"))), "plain")
  })

  it("a denied execution is tool-output-denied", () => {
    assert.deepStrictEqual(chunkOf(result(true, { type: "execution-denied", reason: "no" })), {
      type: "tool-output-denied",
      toolCallId: "c1",
    })
  })

  it("an approval request maps one to one", () => {
    assert.deepStrictEqual(chunkOf(Response.makePart("tool-approval-request", { approvalId: "a1", toolCallId: "c1" })), {
      type: "tool-approval-request",
      approvalId: "a1",
      toolCallId: "c1",
    })
  })
})

describe("everything else", () => {
  it("finish and response-metadata have no chunk", () => {
    assertNone(Response.makePart("finish", { reason: "stop", usage: Response.Usage.make({ inputTokens: {}, outputTokens: {} }) }))
    assertNone(Response.makePart("response-metadata", { modelId: "m" }))
  })

  it("an error part is an error chunk through onError; the default leaks nothing", () => {
    assert.deepStrictEqual(chunkOf(Response.makePart("error", { error: new Error("secret") })), {
      type: "error",
      errorText: "An error occurred.",
    })
    const loud = toUIMessageChunk(WeatherToolkit, { onError: (e) => (e instanceof Error ? e.message : "?") })
    assert.deepStrictEqual(Option.getOrThrow(loud(Response.makePart("error", { error: new Error("secret") }))), {
      type: "error",
      errorText: "secret",
    })
  })

  it("a file is a data url", () => {
    assert.deepStrictEqual(chunkOf(Response.makePart("file", { mediaType: "text/plain", data: new TextEncoder().encode("hi") })), {
      type: "file",
      mediaType: "text/plain",
      url: "data:text/plain;base64,aGk=",
    })
  })

  it("sources are off by default and on by option", () => {
    // `makePart("source", ...)` types its params from both source kinds at once, so the url fields need a cast.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
    const source = Response.makePart("source", { sourceType: "url", id: "s", url: new URL("https://a.b/"), title: "A" } as never)
    assertNone(source)
    assert.deepStrictEqual(Option.getOrThrow(toUIMessageChunk(WeatherToolkit, { sendSources: true })(source)), {
      type: "source-url",
      sourceId: "s",
      url: "https://a.b/",
      title: "A",
    })
  })
})

it.effect("a stream is one step: start-step, the chunks, finish-step; failures pass through", () =>
  Effect.gen(function* () {
    const parts = Stream.make(
      Response.makePart("text-start", { id: "t" }),
      Response.makePart("text-delta", { id: "t", delta: "hi" }),
      Response.makePart("text-end", { id: "t" }),
      Response.makePart("finish", { reason: "stop", usage: Response.Usage.make({ inputTokens: {}, outputTokens: {} }) }),
    )
    const chunks = yield* Stream.runCollect(toUIMessageStream(WeatherToolkit)(parts))
    assert.deepStrictEqual(
      chunks.map((c) => c.type),
      ["start-step", "text-start", "text-delta", "text-end", "finish-step"],
    )

    const failing = Stream.concat(Stream.make(Response.makePart("text-start", { id: "t" })), Stream.fail("offline" as const))
    const exit = yield* Effect.exit(Stream.runCollect(toUIMessageStream(WeatherToolkit)(failing)))
    assert.isTrue(exit._tag === "Failure")
  }),
)
