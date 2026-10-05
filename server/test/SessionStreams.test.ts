import { layer } from "@effect/vitest"
import { assertFailure, assertTrue, deepStrictEqual, strictEqual } from "@effect/vitest/utils"
import { Array, Deferred, Effect, Fiber, Stream } from "effect"
import { SqlClient } from "effect/sql"
import * as Offset from "../src/domain/Offset.ts"
import { SessionId, SessionNotFound } from "../src/domain/Session.ts"
import { VersionConflict } from "../src/domain/SessionEvent.ts"
import type { StreamChunk } from "../src/domain/StreamChunk.ts"
import { SessionEventLog } from "../src/services/SessionEventLog.ts"
import { Sessions } from "../src/services/Sessions.ts"
import { SessionStreams } from "../src/services/SessionStreams.ts"
import { AppTest } from "./support/AppTest.ts"
import { appendEvents, output, turnStarted } from "./support/Events.ts"

const missing = SessionId.make("00000000-0000-7000-8000-000000000000")

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

layer(AppTest)("Session event logs", (it) => {
  it.effect("events are numbered from 0 with no gaps", () =>
    Effect.gen(function*() {
      const log = yield* SessionEventLog
      const id = yield* newSession
      strictEqual(yield* log.nextSeq(id), 0)
      const stored = yield* log.append(id, 0, [output("a"), output("b")])
      deepStrictEqual(stored.map((event) => event.seq), [0, 1])
      yield* log.append(id, 2, [output("c")])
      strictEqual(yield* log.nextSeq(id), 3)
    }))

  it.effect("an append against a stale version is rejected, and nothing is written", () =>
    Effect.gen(function*() {
      const log = yield* SessionEventLog
      const id = yield* newSession
      yield* log.append(id, 0, [output("a")])
      const conflict = yield* Effect.flip(log.append(id, 0, [output("b")]))
      deepStrictEqual(conflict, new VersionConflict({ expected: 0 }))
      strictEqual(yield* log.nextSeq(id), 1)
    }))

  it.effect("appending to an unknown session is a database failure", () =>
    Effect.gen(function*() {
      const log = yield* SessionEventLog
      const error = yield* Effect.flip(log.append(missing, 0, [output("x")]))
      strictEqual(error._tag, "SqlError")
    }))

  it.effect("deleting a session deletes its events", () =>
    Effect.gen(function*() {
      const sessions = yield* Sessions
      const sql = yield* SqlClient.SqlClient
      const id = yield* newSession
      yield* appendEvents(id, [output("a")])
      yield* sessions.remove(id)
      const rows = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM session_events WHERE session_id = ${id}`
      strictEqual(rows[0]?.count, 0)
    }))
})

layer(AppTest)("Session streams (the projection of the log)", (it) => {
  it.effect("an offset is an event's seq: one event can be several chunks", () =>
    Effect.gen(function*() {
      const streams = yield* SessionStreams
      const id = yield* newSession
      strictEqual(yield* streams.nextOffset(id), Offset.beginning)
      yield* appendEvents(id, [turnStarted("hi")])
      const read = yield* streams.catchUp(id, Offset.beginning)
      deepStrictEqual(read.chunks.map((chunk) => chunk.type), ["data-user-message", "data-turn-start", "start"])
      strictEqual(read.next, Offset.Offset.make(1))
    }))

  it.effect("catches up from an offset to the end", () =>
    Effect.gen(function*() {
      const streams = yield* SessionStreams
      const id = yield* newSession
      yield* appendEvents(id, [output("a"), output("b"), output("c")])

      const all = yield* streams.catchUp(id, Offset.beginning)
      strictEqual(textOf(all.chunks), "abc")
      strictEqual(all.next, Offset.Offset.make(3))

      const rest = yield* streams.catchUp(id, Offset.Offset.make(1))
      strictEqual(textOf(rest.chunks), "bc")

      deepStrictEqual(yield* streams.catchUp(id, all.next), { chunks: [], next: all.next })
    }))

  it.effect("`now` reads nothing and returns the next offset", () =>
    Effect.gen(function*() {
      const streams = yield* SessionStreams
      const id = yield* newSession
      yield* appendEvents(id, [output("history")])
      deepStrictEqual(yield* streams.catchUp(id, "now"), { chunks: [], next: Offset.Offset.make(1) })
    }))

  it.effect("unknown sessions have no stream", () =>
    Effect.gen(function*() {
      const streams = yield* SessionStreams
      const notFound = SessionNotFound.make({ id: missing })
      assertFailure(yield* Effect.result(streams.nextOffset(missing)), notFound)
      assertFailure(yield* Effect.result(streams.catchUp(missing, Offset.beginning)), notFound)
    }))

  it.effect("follow: catch-up first, then every append, in order", () =>
    Effect.gen(function*() {
      const streams = yield* SessionStreams
      const id = yield* newSession
      yield* appendEvents(id, [output("a")])

      const reader = yield* forkReader(
        streams.follow(id, Offset.beginning).pipe(Stream.takeUntil((read) => read.next === Offset.Offset.make(4)))
      )
      yield* appendEvents(id, [output("b"), output("c")])
      yield* appendEvents(id, [output("d")])
      const reads = yield* Fiber.join(reader)

      strictEqual(textOf(reads.flatMap((read) => read.chunks)), "abcd")
      assertTrue(reads.every((read, i) => i === 0 || read.chunks.length > 0), "only the catch-up may be empty")
    }))

  it.effect("follow from `now` only sees new appends, and only its own session's", () =>
    Effect.gen(function*() {
      const streams = yield* SessionStreams
      const id = yield* newSession
      const other = yield* newSession
      yield* appendEvents(id, [output("old")])

      const reader = yield* forkReader(streams.follow(id, "now").pipe(Stream.take(2)))
      yield* appendEvents(other, [output("elsewhere")])
      yield* appendEvents(id, [output("new")])
      const [first, second] = yield* Fiber.join(reader)

      deepStrictEqual(first, { chunks: [], next: Offset.Offset.make(1) })
      strictEqual(textOf(Array.fromNullishOr(second).flatMap((read) => read.chunks)), "new")
    }))
})
