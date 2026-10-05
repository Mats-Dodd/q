import { Clock, Effect, Random } from "effect"

/**
 * Durable Streams cursors (PROTOCOL.md §10.1): live responses carry a cursor
 * that changes over time, so CDNs collapsing live requests on `cursor` never
 * serve the same cached response forever.
 *
 * The cursor is the number of 20 second intervals since 2024-10-09T00:00:00Z.
 * Cursors never go backwards: when the client echoes a cursor at or ahead of
 * the current interval, the next one is that plus 1 to 3600 seconds of jitter.
 */
const epoch = Date.UTC(2024, 9, 9)
const intervalMillis = 20_000
const maxJitterIntervals = 3600_000 / intervalMillis

export const next = Effect.fn("Cursor.next")(function*(echoed: string | undefined) {
  const current = Math.floor(((yield* Clock.currentTimeMillis) - epoch) / intervalMillis)
  const client = echoed === undefined ? Number.NaN : Number(echoed)
  if (!Number.isSafeInteger(client) || client < current) {
    return String(current)
  }
  return String(client + (yield* Random.nextIntBetween(1, maxJitterIntervals)))
})
