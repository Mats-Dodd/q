import { layer } from "@effect/vitest"
import { assertFailure, assertTrue, deepStrictEqual, strictEqual } from "@effect/vitest/utils"
import { Array, Deferred, Effect, Fiber, Stream } from "effect"
import { SqlClient } from "effect/sql"
import * as Offset from "../src/domain/Offset.ts"
import { SessionId, SessionNotFound } from "../src/domain/Session.ts"
import type { StreamChunk } from "../src/domain/StreamChunk.ts"
import { Sessions } from "../src/services/Sessions.ts"
import { SessionStreams } from "../src/services/SessionStreams.ts"
import { AppTest } from "./support/AppTest.ts"

const missing = SessionId.make("00000000-0000-7000-8000-000000000000")

const delta = (text: string): StreamChunk => ({ type: "text-delta", id: "t0", delta: text })

/** The text deltas in `chunks`, joined. */
const textOf = (chunks: ReadonlyArray<StreamChunk>) =>
  chunks.map((chunk) => chunk.type === "text-delta" ? chunk.delta : "").join("")

/**
 * Runs `stream` in the background, returning once it has delivered its first
 * read (the catch-up), so it is subscribed to everything appended after.
 */
const forkReader = <A, E>(stream: Stream.Stream<A, E>) =>
  Effect.gen(function*() {
    const caughtUp = yield* Deferred.make<void>()
    const fiber = yield* stream.pipe(
      Stream.tap(() => Deferred.succeed(caughtUp, undefined)),
      Stream.runCollect,
      Effect.forkChild
    )
    yield* Deferred.await(caughtUp)
    return fiber
  })

const newSession = Effect.gen(function*() {
  const sessions = yield* Sessions
  return (yield* sessions.create({ title: "streaming" })).id
})

layer(AppTest)("SessionStreams", (it) => {
  it.effect("appends are numbered from 0 with no gaps", () =>
    Effect.gen(function*() {
      const streams = yield* SessionStreams
      const id = yield* newSession
      strictEqual(yield* streams.nextOffset(id), Offset.beginning)
      strictEqual(yield* streams.append(id, [delta("a"), delta("b")]), Offset.Offset.make(2))
      strictEqual(yield* streams.append(id, [delta("c")]), Offset.Offset.make(3))
      strictEqual(yield* streams.nextOffset(id), Offset.Offset.make(3))
    }))

  it.effect("catches up from an offset to the end", () =>
    Effect.gen(function*() {
      const streams = yield* SessionStreams
      const id = yield* newSession
      yield* streams.append(id, [delta("a"), delta("b"), delta("c")])

      const all = yield* streams.catchUp(id, Offset.beginning)
      strictEqual(textOf(all.chunks), "abc")
      strictEqual(all.next, Offset.Offset.make(3))

      const rest = yield* streams.catchUp(id, Offset.Offset.make(1))
      strictEqual(textOf(rest.chunks), "bc")

      const atTail = yield* streams.catchUp(id, all.next)
      deepStrictEqual(atTail, { chunks: [], next: all.next })
    }))

  it.effect("`now` reads nothing and returns the next offset", () =>
    Effect.gen(function*() {
      const streams = yield* SessionStreams
      const id = yield* newSession
      yield* streams.append(id, [delta("history")])
      deepStrictEqual(yield* streams.catchUp(id, "now"), { chunks: [], next: Offset.Offset.make(1) })
    }))

  it.effect("unknown sessions have no stream", () =>
    Effect.gen(function*() {
      const streams = yield* SessionStreams
      const notFound = SessionNotFound.make({ id: missing })
      assertFailure(yield* Effect.result(streams.nextOffset(missing)), notFound)
      assertFailure(yield* Effect.result(streams.catchUp(missing, Offset.beginning)), notFound)
    }))

  it.effect("appending to an unknown session is a database failure", () =>
    Effect.gen(function*() {
      const streams = yield* SessionStreams
      const error = yield* Effect.flip(streams.append(missing, [delta("x")]))
      strictEqual(error._tag, "SqlError")
    }))

  it.effect("deleting a session deletes its stream", () =>
    Effect.gen(function*() {
      const sessions = yield* Sessions
      const streams = yield* SessionStreams
      const sql = yield* SqlClient.SqlClient
      const id = yield* newSession
      yield* streams.append(id, [delta("a")])
      yield* sessions.remove(id)
      const rows = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM stream_chunks WHERE session_id = ${id}`
      strictEqual(rows[0]?.count, 0)
    }))

  it.effect("live: catch-up first, then every append, in order", () =>
    Effect.gen(function*() {
      const streams = yield* SessionStreams
      const id = yield* newSession
      yield* streams.append(id, [delta("a")])

      const reader = yield* forkReader(
        streams.follow(id, Offset.beginning).pipe(Stream.takeUntil((read) => read.next === Offset.Offset.make(4)))
      )
      yield* streams.append(id, [delta("b"), delta("c")])
      yield* streams.append(id, [delta("d")])
      const reads = yield* Fiber.join(reader)

      strictEqual(textOf(reads.flatMap((read) => read.chunks)), "abcd")
      assertTrue(reads.every((read, i) => i === 0 || read.chunks.length > 0), "only the catch-up may be empty")
    }))

  it.effect("live from `now` only sees new appends, and only its own session's", () =>
    Effect.gen(function*() {
      const streams = yield* SessionStreams
      const id = yield* newSession
      const other = yield* newSession
      yield* streams.append(id, [delta("old")])

      const reader = yield* forkReader(streams.follow(id, "now").pipe(Stream.take(2)))
      yield* streams.append(other, [delta("elsewhere")])
      yield* streams.append(id, [delta("new")])
      const [first, second] = yield* Fiber.join(reader)

      deepStrictEqual(first, { chunks: [], next: Offset.Offset.make(1) })
      strictEqual(textOf(Array.fromNullishOr(second).flatMap((read) => read.chunks)), "new")
    }))
})
