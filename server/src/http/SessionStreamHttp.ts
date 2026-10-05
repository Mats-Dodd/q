import { Array, Duration, Effect, Stream } from "effect"
import { HttpServerResponse } from "effect/http"
import { HttpApiBuilder, HttpApiSchema } from "effect/http-api"
import { Api } from "../api/Api.ts"
import type { StreamEvent } from "../api/SessionStreamApi.ts"
import * as Cursor from "../domain/Cursor.ts"
import * as Offset from "../domain/Offset.ts"
import { type StreamRead, SessionStreams } from "../services/SessionStreams.ts"

/**
 * SSE connections are closed about every minute so CDNs can collapse readers
 * (PROTOCOL.md §10.2); clients reconnect from the last `streamNextOffset`.
 */
const sseLifetime = Duration.seconds(60)

/** A catch-up of a range never changes, so caches may keep it (§10.1); `offset=now` (the end) must not be cached. */
const catchUpCacheControl = "private, max-age=60, stale-while-revalidate=300"

/** Every read's chunks are followed by a control event (§5.8); an empty read is just the control event. */
const sseEventsOf = (read: StreamRead, cursor: string): ReadonlyArray<StreamEvent> => {
  const control: StreamEvent = {
    event: "control",
    data: { streamNextOffset: read.next, streamCursor: cursor, upToDate: true }
  }
  return Array.isReadonlyArrayNonEmpty(read.chunks) ? [{ event: "data", data: read.chunks }, control] : [control]
}

/** Identifies a catch-up: the same range of an append-only stream is always the same chunks. */
const catchUpEtag = (id: string, from: Offset.Offset, next: Offset.Offset) => `"${id}:${from}:${next}"`

export const SessionStreamHttp = HttpApiBuilder.group(
  Api,
  "sessionStream",
  Effect.fnUntraced(function*(handlers) {
    const streams = yield* SessionStreams
    return handlers
      .handle(
        "read",
        Effect.fnUntraced(function*({ headers, params, query }) {
          const from = query.offset ?? Offset.beginning

          if (query.live === "sse") {
            // Unknown sessions are a 404 before the stream starts.
            yield* streams.nextOffset(params.id)
            const cursor = yield* Cursor.next(query.cursor)
            return streams.follow(params.id, from).pipe(
              Stream.flatMap((read) => Stream.fromIterable(sseEventsOf(read, cursor))),
              Stream.interruptWhen(Effect.sleep(sseLifetime)),
              Stream.orDie
            )
          }

          const read = yield* streams.catchUp(params.id, from)
          if (from === "now") {
            return HttpApiSchema.withHeaders({
              body: read.chunks,
              headers: { "stream-next-offset": read.next, "stream-up-to-date": "true", "cache-control": "no-store" } as const
            })
          }
          const etag = catchUpEtag(params.id, from, read.next)
          if (headers["if-none-match"] === etag) {
            return HttpServerResponse.empty({ status: 304, headers: { etag } })
          }
          return HttpApiSchema.withHeaders({
            body: read.chunks,
            headers: { "stream-next-offset": read.next, "stream-up-to-date": "true", "cache-control": catchUpCacheControl, etag } as const
          })
        }, Effect.catchTag("SqlError", Effect.die))
      )
      .handle("metadata", ({ params }) =>
        streams.nextOffset(params.id).pipe(
          Effect.map((next) =>
            HttpApiSchema.withHeaders({
              body: undefined,
              headers: { "stream-next-offset": next, "content-type": "application/json", "cache-control": "no-store" } as const
            })
          ),
          Effect.catchTag("SqlError", Effect.die)
        ))
  })
)
