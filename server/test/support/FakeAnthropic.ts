import { Array, Context, Effect, Layer, Ref, Schedule, Schema, Stream } from "effect"
import { HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/http"

/**
 * A real, local Anthropic Messages API (streaming only) for tests: the model
 * layer talks to it over HTTP exactly as it would to Anthropic. Replies are
 * scripted by the last user message:
 *
 * - `slow …`       streams 40 deltas, 50ms apart (time to cancel)
 * - `fail …`       starts a reply, then sends an `overloaded_error` event
 * - `overloaded …` answers 529 before streaming anything
 * - anything else  streams `Echo: <message>`, a word per delta
 */

const TextPart = Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) })

export const FakeMessage = Schema.Struct({
  role: Schema.String,
  content: Schema.Union([Schema.String, Schema.Array(TextPart)])
})
export type FakeMessage = typeof FakeMessage.Type

const MessagesRequest = Schema.Struct({ messages: Schema.Array(FakeMessage) })

/** A message's text, whichever way its content was sent. */
export const textOf = (message: FakeMessage) =>
  typeof message.content === "string" ? message.content : message.content.map((part) => part.text ?? "").join("")

/** An Anthropic SSE event; its `data` carries the event `type` too. */
interface SseEvent {
  readonly event: string
  readonly data: Schema.Json
}

const sse = (type: string, fields: { readonly [key: string]: Schema.Json } = {}): SseEvent => ({
  event: type,
  data: { type, ...fields }
})

const render = (event: SseEvent) =>
  Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(event.data).pipe(
    Effect.map((data) => `event: ${event.event}\ndata: ${data}\n\n`)
  )

const usage = {
  input_tokens: 10,
  output_tokens: 1,
  cache_creation_input_tokens: null,
  cache_read_input_tokens: null,
  server_tool_use: null,
  service_tier: null,
  cache_creation: null
}

const messageStart = sse("message_start", {
  message: {
    id: "msg_fake",
    type: "message",
    role: "assistant",
    content: [],
    model: "fake",
    stop_reason: null,
    stop_sequence: null,
    usage,
    container: null,
    context_management: null
  }
})
const blockStart = sse("content_block_start", { index: 0, content_block: { type: "text", text: "", citations: null } })
const delta = (text: string) => sse("content_block_delta", { index: 0, delta: { type: "text_delta", text } })
const blockStop = sse("content_block_stop", { index: 0 })
const messageEnd = [
  sse("message_delta", {
    delta: { stop_reason: "end_turn", stop_sequence: null, container: null },
    usage: { output_tokens: 5, input_tokens: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null },
    context_management: null
  }),
  sse("message_stop")
]
const overloadedError = { error: { type: "overloaded_error", message: "Overloaded" }, request_id: null }

const reply = (deltas: ReadonlyArray<string>) => [messageStart, blockStart, ...deltas.map(delta), blockStop, ...messageEnd]

const events = (stream: Stream.Stream<SseEvent>) =>
  HttpServerResponse.stream(stream.pipe(Stream.mapEffect(render), Stream.encodeText), {
    contentType: "text/event-stream"
  })

const respond = (prompts: Ref.Ref<ReadonlyArray<ReadonlyArray<FakeMessage>>>) =>
  Effect.gen(function*() {
    const { messages } = yield* HttpServerRequest.schemaBodyJson(MessagesRequest)
    yield* Ref.update(prompts, Array.append(messages))
    const said = textOf(Array.lastNonEmpty([{ role: "user", content: "" }, ...messages]))
    if (said.startsWith("overloaded")) {
      return HttpServerResponse.jsonUnsafe({ type: "error", ...overloadedError }, { status: 529 })
    }
    if (said.startsWith("fail")) {
      return events(Stream.make(messageStart, blockStart, delta("Partial"), sse("error", overloadedError)))
    }
    if (said.startsWith("slow")) {
      return events(Stream.fromIterable(reply(Array.replicate(".", 40))).pipe(Stream.schedule(Schedule.spaced("50 millis"))))
    }
    return events(Stream.fromIterable(reply(`Echo: ${said}`.split(/(?= )/))))
  }).pipe(Effect.orDie)

export interface FakeAnthropicShape {
  /** Base URL to point `Q_ANTHROPIC_URL` at. */
  readonly url: string
  /** Every prompt received, in order: the messages of each request. */
  readonly prompts: Effect.Effect<ReadonlyArray<ReadonlyArray<FakeMessage>>>
}

export class FakeAnthropic extends Context.Service<FakeAnthropic, FakeAnthropicShape>()(
  "@q/server/test/support/FakeAnthropic"
) {
  /** Served on `port` (0: any free port). */
  static readonly layerAt = (port: number) =>
    Layer.effect(
      FakeAnthropic,
      Effect.gen(function*() {
        const prompts = yield* Ref.make<ReadonlyArray<ReadonlyArray<FakeMessage>>>([])
        const handler = HttpEffect.toWebHandler(respond(prompts))
        const server = yield* Effect.acquireRelease(
          Effect.sync(() => Bun.serve({ hostname: "127.0.0.1", port, fetch: (request) => handler(request) })),
          (running) => Effect.promise(() => running.stop(true))
        )
        return { url: server.url.origin, prompts: Ref.get(prompts) } satisfies FakeAnthropicShape
      })
    )

  static readonly layer = FakeAnthropic.layerAt(0)
}
