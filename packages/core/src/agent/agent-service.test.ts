import { BunServices } from "@effect/platform-bun"
import { assert, it } from "@effect/vitest"
import { makeUserMessage } from "@q/factories/conversation-model"
import { ConfigProvider, Context, Effect, Layer, Ref, Stream } from "effect"
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/unstable/http"

import { AgentService } from "./agent-service"

// The Anthropic Layer against a recording HTTP client: what leaves the process, not what the model says.

/** The JSON a request carries, for assertions on what the provider was told. */
const bodyOf = (
  request: HttpClientRequest.HttpClientRequest,
): { system?: ReadonlyArray<{ type: "text"; text: string }>; tools?: ReadonlyArray<{ name: string }> } => {
  assert.strictEqual(request.body._tag, "Uint8Array")
  return JSON.parse(new TextDecoder().decode((request.body as { body: Uint8Array }).body))
}

const sse = (events: ReadonlyArray<readonly [string, unknown]>) =>
  events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("")

const usage = {
  cache_creation: null,
  cache_creation_input_tokens: null,
  cache_read_input_tokens: null,
  inference_geo: null,
  input_tokens: 1,
  output_tokens: 0,
  server_tool_use: null,
  service_tier: null,
}

/** One text turn, as Anthropic streams it. */
const textTurn = sse([
  [
    "message_start",
    {
      type: "message_start",
      message: { id: "m", type: "message", role: "assistant", model: "x", content: [], stop_reason: null, stop_sequence: null, usage },
    },
  ],
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  [
    "message_delta",
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { cache_creation_input_tokens: null, cache_read_input_tokens: null, input_tokens: 1, output_tokens: 1, server_tool_use: null },
    },
  ],
  ["message_stop", { type: "message_stop" }],
])

it.effect("the Anthropic layer sends the key from ANTHROPIC_API_KEY, the four tools and the working directory, and reads the stream", () =>
  Effect.gen(function* () {
    const requests = yield* Ref.make<ReadonlyArray<HttpClientRequest.HttpClientRequest>>([])
    const recording = HttpClient.make((request) =>
      Effect.as(
        Ref.update(requests, (all) => [...all, request]),
        HttpClientResponse.fromWeb(request, new Response(textTurn, { headers: { "content-type": "text/event-stream" } })),
      ),
    )
    const layer = AgentService.layerAnthropic("claude-test").pipe(
      Layer.provide(Layer.succeed(HttpClient.HttpClient, recording)),
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ ANTHROPIC_API_KEY: "sk-test" }))),
      Layer.provide(BunServices.layer),
    )
    const agent = Context.get(yield* Layer.build(layer), AgentService)

    const chunks = yield* Stream.runCollect(agent.step([makeUserMessage("0", "hello")], { cwd: "/work/here" }))
    assert.deepStrictEqual(
      chunks.map((c) => c.type),
      ["start-step", "text-start", "text-delta", "text-end", "finish-step"],
    )

    const [request] = yield* Ref.get(requests)
    assert.isDefined(request)
    assert.strictEqual(request.headers["x-api-key"], "sk-test")
    assert.strictEqual(request.url, "https://api.anthropic.com/v1/messages")
    const body = bodyOf(request)
    assert.deepStrictEqual(
      body.tools?.map((tool) => tool.name),
      ["read", "write", "edit", "bash"],
    )
    assert.include(body.system?.map((block) => block.text).join("\n"), "/work/here")
  }),
)
