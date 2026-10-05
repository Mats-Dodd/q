import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"
import { Offset, ReadFrom } from "../domain/Offset.ts"
import { SessionId, SessionNotFound } from "../domain/Session.ts"
import { StreamChunk } from "../domain/StreamChunk.ts"

/**
 * A session's stream, served with the read side of the Durable Streams protocol
 * (https://github.com/durable-streams/durable-streams, PROTOCOL.md) in JSON mode:
 * each JSON message is one `StreamChunk`. Only the server appends, so the write
 * operations (create, append, close, delete) are not exposed.
 */

const params = { id: SessionId }

const StreamChunks = Schema.Array(StreamChunk).annotate({ identifier: "StreamChunks" })

/** The `control` event that follows every `data` event in SSE mode (§5.8). */
export const StreamControl = Schema.Struct({
  streamNextOffset: Offset,
  streamCursor: Schema.optionalKey(Schema.String),
  upToDate: Schema.optionalKey(Schema.Boolean),
  streamClosed: Schema.optionalKey(Schema.Boolean)
}).annotate({ identifier: "StreamControl" })
export type StreamControl = typeof StreamControl.Type

/**
 * An SSE event: chunks appended to the stream, or where the reader now is. SSE data is
 * text, so to OpenAPI these are JSON strings; `codegen/Codegen.ts` lists
 * `StreamControl` separately so generated clients still get its object type.
 */
export const StreamEvent = Schema.Union([
  Schema.Struct({
    event: Schema.Literal("data"),
    data: Schema.fromJsonString(Schema.toCodecJson(StreamChunks)).annotate({ identifier: "StreamChunksJson" })
  }).annotate({ identifier: "StreamDataEvent" }),
  Schema.Struct({
    event: Schema.Literal("control"),
    data: Schema.fromJsonString(StreamControl).annotate({ identifier: "StreamControlJson" })
  }).annotate({ identifier: "StreamControlEvent" })
]).annotate({ identifier: "StreamEvent" })
export type StreamEvent = typeof StreamEvent.Type

const tailHeaders = {
  "stream-next-offset": Offset,
  "cache-control": Schema.String
}

/** Catch-up read (§5.6): every chunk from `offset` to the end. */
const CatchUp = HttpApiSchema.WithHeaders(StreamChunks, {
  ...tailHeaders,
  "stream-up-to-date": Schema.Literal("true"),
  etag: Schema.optionalKey(Schema.String)
})

/**
 * Live read (§5.8): catch-up, then each append as it happens. (One response per
 * status may carry headers; `http/Http.ts` marks every SSE response `no-cache`.)
 */
const Live = HttpApiSchema.StreamSse({ events: StreamEvent })

const ReadQuery = Schema.Struct({
  /** Defaults to the start of the stream (`-1`). */
  offset: Schema.optionalKey(ReadFrom),
  live: Schema.optionalKey(Schema.Literal("sse")),
  /** The `streamCursor` from the last control event, echoed back for CDN collapsing (§10.1). */
  cursor: Schema.optionalKey(Schema.String)
}).check(Schema.makeFilter((query) =>
  query.live === undefined || query.offset !== undefined ||
  { path: ["offset"], issue: "offset is required for live reads" }
))

export class SessionStreamApi extends HttpApiGroup.make("sessionStream")
  .add(
    HttpApiEndpoint.get("read", "/sessions/:id/stream", {
      params,
      query: ReadQuery,
      headers: { "if-none-match": Schema.optionalKey(Schema.String) },
      success: [CatchUp, Live],
      error: SessionNotFound
    }),
    /** Stream metadata (§5.5): the next offset, without a body. */
    HttpApiEndpoint.head("metadata", "/sessions/:id/stream", {
      params,
      success: HttpApiSchema.WithHeaders(HttpApiSchema.Empty(200), {
        ...tailHeaders,
        "content-type": Schema.Literal("application/json")
      }),
      error: SessionNotFound
    })
  )
{}
