import { Filter, Option, Schema, Stream } from "effect"
import type { Tool, Toolkit } from "effect/unstable/ai"

import type { ToolsOf } from "./ui-message"
import { UIMessageChunk } from "./ui-message-chunk"

/**
 * The wire. The AI SDK UI message stream is server-sent events: one `data: <json>` line per chunk,
 * a blank line between events, `data: [DONE]` at the end, and a header that names the protocol.
 *
 * @since 0.1.0
 */

/**
 * The response headers of a UI message stream.
 *
 * @since 0.1.0
 */
export const UI_MESSAGE_STREAM_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  connection: "keep-alive",
  "x-vercel-ai-ui-message-stream": "v1",
  "x-accel-buffering": "no",
} as const

/**
 * The last event of a stream.
 *
 * @since 0.1.0
 */
export const DONE = "data: [DONE]\n\n"

/**
 * One chunk as one SSE event.
 *
 * @since 0.1.0
 */
export const encodeChunk = (chunk: UIMessageChunk<Record<string, Tool.Any>>): string => `data: ${JSON.stringify(chunk)}\n\n`

/**
 * Chunks to bytes: each chunk as an event, then `[DONE]`.
 *
 * @since 0.1.0
 */
export const toSseStream = <Tools extends Record<string, Tool.Any>, E, R>(
  stream: Stream.Stream<UIMessageChunk<Tools>, E, R>,
): Stream.Stream<Uint8Array, E, R> => Stream.map(stream, encodeChunk).pipe(Stream.concat(Stream.make(DONE)), Stream.encodeText)

/**
 * Bytes to chunks, decoded against the toolkit's chunk schema. Ends at `[DONE]`. Lines that are not
 * `data:` (comments, event names, blanks) are skipped.
 *
 * @since 0.1.0
 */
export const fromSseStream =
  <T extends Toolkit.Any>(toolkit: T) =>
  <E, R>(stream: Stream.Stream<Uint8Array, E, R>): Stream.Stream<UIMessageChunk<ToolsOf<T>>, E | Schema.SchemaError, R> => {
    const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(UIMessageChunk(toolkit)))
    return stream.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.filterMap(
        Filter.fromPredicateOption((line: string) =>
          line.startsWith("data:") ? Option.some(line.slice("data:".length).trim()) : Option.none(),
        ),
      ),
      Stream.takeWhile((data) => data !== "[DONE]"),
      Stream.mapEffect((data) => decode(data)),
    )
  }
