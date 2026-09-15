import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Toolkit } from "effect/unstable/ai"

import { getToolName, isToolUIPart, ToolUIPart, UIMessage, UIMessagePart } from "./ui-message"
import { UIMessageChunk } from "./ui-message-chunk"
import { GetWeather, WeatherToolkit } from "./weather.fixture"

// The schemas: typed from the toolkit, JSON on the wire, and the same JSON back.

const Message = UIMessage(WeatherToolkit)
const Part = UIMessagePart(WeatherToolkit)
const Chunk = UIMessageChunk(WeatherToolkit)

const decodes = <S extends Schema.Top>(schema: S, value: unknown) => Effect.exit(Schema.decodeUnknownEffect(schema)(value))

describe("tool parts", () => {
  it.effect("a tool part is typed by the tool's encoded parameters and success", () =>
    Effect.gen(function* () {
      const part = yield* Schema.decodeEffect(Part)({
        type: "tool-get_weather",
        toolCallId: "c1",
        state: "output-available",
        input: { city: "Oslo" },
        output: { temperatureC: 3, sky: "grey" },
      })
      assert.isTrue(isToolUIPart(part))
      if (part.type === "tool-get_weather" && part.state === "output-available") {
        const city: string = part.input.city
        const temperature: number = part.output.temperatureC
        assert.deepStrictEqual([city, temperature], ["Oslo", 3])
      }
      if (isToolUIPart(part)) assert.strictEqual(getToolName(part), "get_weather")
    }),
  )

  it.effect("the wrong input for a tool, or a tool the toolkit does not have, is rejected", () =>
    Effect.gen(function* () {
      const wrongInput = yield* decodes(Part, {
        type: "tool-get_weather",
        toolCallId: "c1",
        state: "input-available",
        input: { town: "Oslo" },
      })
      assert.strictEqual(wrongInput._tag, "Failure")
      const wrongTool = yield* decodes(Part, { type: "tool-made_up", toolCallId: "c1", state: "input-available", input: {} })
      assert.strictEqual(wrongTool._tag, "Failure")
      // An unknown tool is fine when it says so.
      const dynamic = yield* decodes(Part, {
        type: "dynamic-tool",
        toolName: "made_up",
        toolCallId: "c1",
        state: "input-available",
        input: {},
      })
      assert.strictEqual(dynamic._tag, "Success")
    }),
  )

  it.effect("output-error accepts any input: it is what the model sent", () =>
    Effect.gen(function* () {
      const exit = yield* decodes(Part, { type: "tool-get_weather", toolCallId: "c1", state: "output-error", input: 42, errorText: "bad" })
      assert.strictEqual(exit._tag, "Success")
    }),
  )

  it.effect("a one-tool schema stands alone", () =>
    Effect.gen(function* () {
      const One = ToolUIPart(GetWeather.name, GetWeather.parametersSchema, GetWeather.successSchema)
      const part = yield* Schema.decodeEffect(One)({ type: "tool-get_weather", toolCallId: "c1", state: "input-streaming" })
      assert.strictEqual(part.state, "input-streaming")
    }),
  )
})

describe("chunks", () => {
  it.effect("tool-input-available is typed by tool name; tool-output-available by the union of outputs", () =>
    Effect.gen(function* () {
      const input = yield* Schema.decodeEffect(Chunk)({
        type: "tool-input-available",
        toolCallId: "c",
        toolName: "echo",
        input: { text: "x" },
      })
      if (input.type === "tool-input-available" && !input.dynamic && input.toolName === "echo") {
        const text: string = input.input.text
        assert.strictEqual(text, "x")
      }
      const bad = yield* decodes(Chunk, { type: "tool-input-available", toolCallId: "c", toolName: "echo", input: { city: "x" } })
      assert.strictEqual(bad._tag, "Failure")
      const output = yield* decodes(Chunk, { type: "tool-output-available", toolCallId: "c", output: { text: "x" } })
      assert.strictEqual(output._tag, "Success")
      const badOutput = yield* decodes(Chunk, { type: "tool-output-available", toolCallId: "c", output: { nope: true } })
      assert.strictEqual(badOutput._tag, "Failure")
      const dynamicOutput = yield* decodes(Chunk, { type: "tool-output-available", toolCallId: "c", dynamic: true, output: { nope: true } })
      assert.strictEqual(dynamicOutput._tag, "Success")
    }),
  )

  it.effect("an empty toolkit still has every protocol chunk", () =>
    Effect.gen(function* () {
      const Empty = UIMessageChunk(Toolkit.empty)
      const exit = yield* decodes(Empty, { type: "text-delta", id: "t", delta: "x" })
      assert.strictEqual(exit._tag, "Success")
    }),
  )
})

const roundTrips = <S extends Schema.Codec<unknown, unknown, never, never>>(name: string, schema: S) => {
  const json = Schema.toCodecJson(schema)
  it.effect.prop(`${name} round-trips through JSON`, { value: schema }, ({ value }) =>
    Effect.gen(function* () {
      const wire = JSON.stringify(yield* Schema.encodeEffect(json)(value))
      const decoded = yield* Schema.decodeEffect(json)(JSON.parse(wire))
      assert.strictEqual(JSON.stringify(yield* Schema.encodeEffect(json)(decoded)), wire)
    }),
  )
}

describe("the wire", () => {
  roundTrips("UIMessage", Message)
  roundTrips("UIMessageChunk", Chunk)
})
