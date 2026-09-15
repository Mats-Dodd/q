import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema, Stream } from "effect"
import { Prompt, Response } from "effect/unstable/ai"

import { convertToModelMessages } from "./model-messages"
import type { UIMessage } from "./ui-message"
import { emptyAssistant, foldUIMessageStream } from "./ui-message-reducer"
import { toUIMessageStream } from "./ui-message-stream"
import { WeatherToolkit } from "./weather.fixture"

type Tools = typeof WeatherToolkit.tools
type Message = UIMessage<Tools>

// A script is one model step, at the level of "what happened": a text, a reasoning, a tool call
// that succeeded. From it come the Effect parts a LanguageModel would stream. Ids are positions,
// so they are unique the way a provider's are.
const Script = Schema.Array(
  Schema.Union([
    Schema.TaggedStruct("Text", { deltas: Schema.Array(Schema.String) }),
    Schema.TaggedStruct("Reasoning", { deltas: Schema.Array(Schema.String) }),
    Schema.TaggedStruct("Weather", { city: Schema.String, temperatureC: Schema.Finite, sky: Schema.String }),
    Schema.TaggedStruct("Echo", { text: Schema.String }),
  ]),
)

type Part = Response.StreamPart<Tools, "opaque">

const partsOf = (script: typeof Script.Type): ReadonlyArray<Part> =>
  script.flatMap((step, i): ReadonlyArray<Part> => {
    const id = `id-${i}`
    switch (step._tag) {
      case "Text":
        return [
          Response.makePart("text-start", { id }),
          ...step.deltas.map((delta) => Response.makePart("text-delta", { id, delta })),
          Response.makePart("text-end", { id }),
        ]
      case "Reasoning":
        return [
          Response.makePart("reasoning-start", { id }),
          ...step.deltas.map((delta) => Response.makePart("reasoning-delta", { id, delta })),
          Response.makePart("reasoning-end", { id }),
        ]
      case "Weather": {
        const result = { temperatureC: step.temperatureC, sky: step.sky }
        return [
          Response.makePart("tool-params-start", { id, name: "get_weather", providerExecuted: false }),
          Response.makePart("tool-params-delta", { id, delta: JSON.stringify({ city: step.city }) }),
          Response.makePart("tool-params-end", { id }),
          Response.makePart("tool-call", { id, name: "get_weather", params: { city: step.city }, providerExecuted: false }),
          Response.makePart("tool-result", {
            id,
            name: "get_weather",
            isFailure: false,
            result,
            encodedResult: result,
            providerExecuted: false,
            preliminary: false,
          }),
        ]
      }
      case "Echo": {
        const result = { text: step.text }
        return [
          Response.makePart("tool-call", { id, name: "echo", params: { text: step.text }, providerExecuted: false }),
          Response.makePart("tool-result", {
            id,
            name: "echo",
            isFailure: false,
            result,
            encodedResult: result,
            providerExecuted: false,
            preliminary: false,
          }),
        ]
      }
    }
  })

/** Effect parts → chunks → UIMessage → Prompt. */
const roundTrip = (parts: ReadonlyArray<Part>) =>
  Effect.map(foldUIMessageStream(toUIMessageStream(WeatherToolkit)(Stream.fromIterable(parts)), emptyAssistant<Tools>("m")), (message) =>
    convertToModelMessages([message]),
  )

it.effect.prop(
  "for one step, UIMessage → Prompt equals Prompt.fromResponseParts on the same parts",
  { script: Script },
  ({ script }) =>
    Effect.gen(function* () {
      const parts = partsOf(script)
      const ours = yield* roundTrip(parts)
      assert.deepStrictEqual(ours.content, Prompt.fromResponseParts(parts).content)
    }),
  { arbitrary: { runs: 200 } },
)

describe("roles", () => {
  it("a user message is its text and file parts; a system message is its text", () => {
    const prompt = convertToModelMessages<Tools>([
      { id: "s", role: "system", parts: [{ type: "text", text: "Be brief." }] },
      {
        id: "u",
        role: "user",
        parts: [
          { type: "text", text: "hi" },
          { type: "file", mediaType: "text/plain", url: "data:text/plain;base64,aGk=" },
        ],
      },
    ])
    assert.deepStrictEqual(prompt.content, [
      Prompt.makeMessage("system", { content: "Be brief." }),
      Prompt.makeMessage("user", {
        content: [Prompt.makePart("text", { text: "hi" }), Prompt.makePart("file", { mediaType: "text/plain", data: "aGk=" })],
      }),
    ])
  })

  it("messages with nothing to say are dropped", () => {
    assert.deepStrictEqual(
      convertToModelMessages<Tools>([
        { id: "u", role: "user", parts: [] },
        { id: "a", role: "assistant", parts: [{ type: "step-start" }] },
      ]).content,
      [],
    )
  })
})

describe("assistant steps", () => {
  const call = { type: "tool-get_weather", toolCallId: "c1", input: { city: "Oslo" } } as const
  const output = { temperatureC: 3, sky: "grey" }

  it("each step-start opens a new assistant message, and its tool results follow it", () => {
    const message: Message = {
      id: "a",
      role: "assistant",
      parts: [
        { type: "step-start" },
        { ...call, state: "output-available", output },
        { type: "step-start" },
        { type: "text", text: "3 degrees.", state: "done" },
      ],
    }
    assert.deepStrictEqual(
      convertToModelMessages([message]).content.map((m) => m.role),
      ["assistant", "tool", "assistant"],
    )
  })

  it("incomplete tool calls are dropped: a provider rejects a call with no result", () => {
    const message: Message = {
      id: "a",
      role: "assistant",
      parts: [
        { type: "text", text: "Looking.", state: "done" },
        { type: "tool-get_weather", toolCallId: "c0", state: "input-streaming" },
        { ...call, state: "input-available" },
        { ...call, toolCallId: "c2", state: "approval-requested", approval: { id: "a2" } },
      ],
    }
    assert.deepStrictEqual(convertToModelMessages([message]).content, [
      Prompt.makeMessage("assistant", { content: [Prompt.makePart("text", { text: "Looking." })] }),
    ])
  })

  it("an output error is a failed result with the error text", () => {
    const message: Message = { id: "a", role: "assistant", parts: [{ ...call, state: "output-error", errorText: "boom" }] }
    const tool = convertToModelMessages([message]).content[1]!
    assert.deepStrictEqual(tool, {
      ...Prompt.makeMessage("tool", {
        content: [
          Prompt.makePart("tool-result", { id: "c1", name: "get_weather", isFailure: true, result: "boom", providerExecuted: false }),
        ],
      }),
    })
  })

  it("a responded approval is the request and the response, and no result: the LanguageModel writes that", () => {
    const message: Message = {
      id: "a",
      role: "assistant",
      parts: [{ ...call, state: "approval-responded", approval: { id: "a1", approved: false, reason: "no" } }],
    }
    assert.deepStrictEqual(convertToModelMessages([message]).content, [
      Prompt.makeMessage("assistant", {
        content: [
          Prompt.makePart("tool-call", { id: "c1", name: "get_weather", params: { city: "Oslo" }, providerExecuted: false }),
          Prompt.makePart("tool-approval-request", { approvalId: "a1", toolCallId: "c1" }),
        ],
      }),
      Prompt.makeMessage("tool", {
        content: [Prompt.makePart("tool-approval-response", { approvalId: "a1", approved: false, reason: "no" })],
      }),
    ])
  })

  it("a denied call is an execution-denied result", () => {
    const message: Message = {
      id: "a",
      role: "assistant",
      parts: [{ ...call, state: "output-denied", approval: { id: "a1", approved: false, reason: "no" } }],
    }
    const tool = convertToModelMessages([message]).content[1]!
    assert.strictEqual(tool.role, "tool")
    if (tool.role === "tool") {
      assert.deepStrictEqual(
        tool.content.map((p) => p.type),
        ["tool-approval-response", "tool-result"],
      )
      const result = tool.content[1]!
      if (result.type === "tool-result") assert.deepStrictEqual(result.result, { type: "execution-denied", reason: "no" })
    }
  })

  it("a dynamic tool part uses its toolName", () => {
    const message: Message = {
      id: "a",
      role: "assistant",
      parts: [{ type: "dynamic-tool", toolName: "made_up", toolCallId: "d", state: "output-available", input: 1, output: 2 }],
    }
    const [assistant, tool] = convertToModelMessages([message]).content
    assert.deepStrictEqual(
      assistant,
      Prompt.makeMessage("assistant", {
        content: [Prompt.makePart("tool-call", { id: "d", name: "made_up", params: 1, providerExecuted: false })],
      }),
    )
    assert.deepStrictEqual(
      tool,
      Prompt.makeMessage("tool", {
        content: [Prompt.makePart("tool-result", { id: "d", name: "made_up", isFailure: false, result: 2, providerExecuted: false })],
      }),
    )
  })
})
