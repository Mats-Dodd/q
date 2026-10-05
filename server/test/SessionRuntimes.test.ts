import { BunServices } from "@effect/platform-bun"
import { layer } from "@effect/vitest"
import { assertEquals, assertFailure, assertTrue, deepStrictEqual, strictEqual } from "@effect/vitest/utils"
import { Context, DateTime, Effect, FileSystem, Layer, Path, Stream } from "effect"
import { SqlClient } from "effect/sql"
import * as Offset from "../src/domain/Offset.ts"
import { SessionId, SessionNotFound } from "../src/domain/Session.ts"
import type { StreamChunk } from "../src/domain/StreamChunk.ts"
import { type TurnId, TurnInProgress, TurnNotRunning, type TurnStatus } from "../src/domain/Turn.ts"
import { SessionRuntimes } from "../src/services/SessionRuntimes.ts"
import { Sessions } from "../src/services/Sessions.ts"
import { SessionStreams } from "../src/services/SessionStreams.ts"
import { appTest, AppTest } from "./support/AppTest.ts"
import { FakeAnthropic, textOf } from "./support/FakeAnthropic.ts"
import { newTurnId } from "./support/Ids.ts"

const newSession = Effect.gen(function*() {
  const sessions = yield* Sessions
  return (yield* sessions.create({ title: "agent" })).id
})

/** The session's stream from the start until `turnId` ends. */
const untilTurnEnds = (sessionId: SessionId, turnId: TurnId) =>
  Effect.gen(function*() {
    const streams = yield* SessionStreams
    return yield* streams.follow(sessionId, Offset.beginning).pipe(
      Stream.flatMap((read) => Stream.fromIterable(read.chunks)),
      Stream.takeUntil((chunk) => chunk.type === "data-turn-end" && chunk.id === turnId),
      Stream.runCollect
    )
  })

/** Waits for the turn's first text delta: the model is mid-reply. */
const untilReplying = (sessionId: SessionId) =>
  Effect.gen(function*() {
    const streams = yield* SessionStreams
    yield* streams.follow(sessionId, Offset.beginning).pipe(
      Stream.flatMap((read) => Stream.fromIterable(read.chunks)),
      Stream.takeUntil((chunk) => chunk.type === "text-delta"),
      Stream.runDrain
    )
  })

const replyText = (chunks: ReadonlyArray<StreamChunk>) =>
  chunks.map((chunk) => chunk.type === "text-delta" ? chunk.delta : "").join("")

const turnEndOf = (chunks: ReadonlyArray<StreamChunk>) => chunks.findLast((chunk) => chunk.type === "data-turn-end")

const statusOf = (turnId: TurnId) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ readonly status: TurnStatus }>`SELECT status FROM turns WHERE id = ${turnId}`
    return rows[0]?.status
  })

// Real time: the model streams in real time, over real HTTP.
layer(AppTest, { excludeTestServices: true })("SessionRuntimes", (it) => {
  it.effect("a turn streams the user's message, then the model's reply, then its end", () =>
    Effect.gen(function*() {
      const runtimes = yield* SessionRuntimes
      const sessionId = yield* newSession
      const turnId = yield* newTurnId

      const turn = yield* runtimes.startTurn(sessionId, { turnId, text: "hello there" })
      strictEqual(turn.status, "running")
      const chunks = yield* untilTurnEnds(sessionId, turnId)

      deepStrictEqual(chunks.map((chunk) => chunk.type), [
        "data-user-message",
        "data-turn-start",
        "start",
        "start-step",
        "text-start",
        ...Array.from({ length: 3 }, () => "text-delta" as const),
        "text-end",
        "finish-step",
        "finish",
        "data-turn-end"
      ])
      deepStrictEqual(chunks[0], { type: "data-user-message", id: turnId, data: { text: "hello there" } })
      strictEqual(replyText(chunks), "Echo: hello there")
      deepStrictEqual(chunks.find((chunk) => chunk.type === "finish"), { type: "finish", finishReason: "stop" })
      deepStrictEqual(turnEndOf(chunks), { type: "data-turn-end", id: turnId, data: { reason: "completed" } })
      strictEqual(yield* statusOf(turnId), "completed")
    }))

  it.effect("the model sees the whole conversation", () =>
    Effect.gen(function*() {
      const runtimes = yield* SessionRuntimes
      const fake = yield* FakeAnthropic
      const sessionId = yield* newSession
      const first = yield* newTurnId
      yield* runtimes.startTurn(sessionId, { turnId: first, text: "one" })
      yield* untilTurnEnds(sessionId, first)
      const second = yield* newTurnId
      yield* runtimes.startTurn(sessionId, { turnId: second, text: "two" })
      yield* untilTurnEnds(sessionId, second)

      const prompt = (yield* fake.prompts).at(-1) ?? []
      deepStrictEqual(prompt.map((message) => [message.role, textOf(message)]), [
        ["user", "one"],
        ["assistant", "Echo: one"],
        ["user", "two"]
      ])
    }))

  it.effect("a cancelled reply is remembered as far as it got; a failed one is not", () =>
    Effect.gen(function*() {
      const runtimes = yield* SessionRuntimes
      const fake = yield* FakeAnthropic
      const sessionId = yield* newSession
      const slow = yield* newTurnId
      yield* runtimes.startTurn(sessionId, { turnId: slow, text: "slow please" })
      yield* untilReplying(sessionId)
      yield* runtimes.cancelTurn(sessionId)
      const failing = yield* newTurnId
      yield* runtimes.startTurn(sessionId, { turnId: failing, text: "overloaded" })
      yield* untilTurnEnds(sessionId, failing)
      const last = yield* newTurnId
      yield* runtimes.startTurn(sessionId, { turnId: last, text: "and now?" })
      yield* untilTurnEnds(sessionId, last)

      // The failed turn left no reply, so its message and the next reach the model
      // together (the provider merges consecutive user messages).
      const prompt = (yield* fake.prompts).at(-1) ?? []
      deepStrictEqual(prompt.map((message) => message.role), ["user", "assistant", "user"])
      assertTrue(textOf(prompt[1] ?? { role: "", content: "" }).startsWith("."), "the partial reply")
      strictEqual(textOf(prompt[2] ?? { role: "", content: "" }), "overloadedand now?")
    }))

  it.effect("sending the same turn again does not start it again", () =>
    Effect.gen(function*() {
      const runtimes = yield* SessionRuntimes
      const fake = yield* FakeAnthropic
      const sessionId = yield* newSession
      const turnId = yield* newTurnId
      const promptsBefore = (yield* fake.prompts).length

      const turn = yield* runtimes.startTurn(sessionId, { turnId, text: "once" })
      const retried = yield* runtimes.startTurn(sessionId, { turnId, text: "once" })
      strictEqual(retried.id, turn.id)
      const chunks = yield* untilTurnEnds(sessionId, turnId)
      // Retrying after it finished returns the finished turn.
      strictEqual((yield* runtimes.startTurn(sessionId, { turnId, text: "once" })).status, "completed")

      strictEqual(chunks.filter((chunk) => chunk.type === "data-user-message").length, 1)
      strictEqual((yield* fake.prompts).length, promptsBefore + 1)
    }))

  it.effect("one turn at a time per session", () =>
    Effect.gen(function*() {
      const runtimes = yield* SessionRuntimes
      const sessionId = yield* newSession
      const slow = yield* newTurnId
      yield* runtimes.startTurn(sessionId, { turnId: slow, text: "slow please" })

      const second = yield* Effect.result(runtimes.startTurn(sessionId, { turnId: yield* newTurnId, text: "me too" }))
      assertFailure(second, TurnInProgress.make({ sessionId }))

      // Other sessions are unaffected.
      const elsewhere = yield* newSession
      const other = yield* newTurnId
      yield* runtimes.startTurn(elsewhere, { turnId: other, text: "hi" })
      yield* untilTurnEnds(elsewhere, other)
      yield* runtimes.cancelTurn(sessionId)
    }))

  it.effect("cancelling interrupts the model and records it", () =>
    Effect.gen(function*() {
      const runtimes = yield* SessionRuntimes
      const sessionId = yield* newSession
      const turnId = yield* newTurnId
      yield* runtimes.startTurn(sessionId, { turnId, text: "slow please" })
      yield* untilReplying(sessionId)

      yield* runtimes.cancelTurn(sessionId)
      const chunks = yield* untilTurnEnds(sessionId, turnId)
      deepStrictEqual(chunks.slice(-2), [
        { type: "abort", reason: "cancelled" },
        { type: "data-turn-end", id: turnId, data: { reason: "cancelled" } }
      ])
      assertTrue(replyText(chunks).length < 40, "the reply was cut short")
      strictEqual(yield* statusOf(turnId), "cancelled")

      assertFailure(yield* Effect.result(runtimes.cancelTurn(sessionId)), TurnNotRunning.make({ sessionId }))
      // The session is free again.
      const next = yield* newTurnId
      yield* runtimes.startTurn(sessionId, { turnId: next, text: "again" })
      strictEqual(turnEndOf(yield* untilTurnEnds(sessionId, next))?.type, "data-turn-end")
    }))

  it.effect("a model that fails before replying fails the turn", () =>
    Effect.gen(function*() {
      const runtimes = yield* SessionRuntimes
      const sessionId = yield* newSession
      const turnId = yield* newTurnId
      yield* runtimes.startTurn(sessionId, { turnId, text: "overloaded" })
      const chunks = yield* untilTurnEnds(sessionId, turnId)

      strictEqual(chunks.at(-2)?.type, "error")
      deepStrictEqual(turnEndOf(chunks), { type: "data-turn-end", id: turnId, data: { reason: "failed" } })
      strictEqual(yield* statusOf(turnId), "failed")
    }))

  it.effect("a model that fails mid-reply keeps what it said and fails the turn", () =>
    Effect.gen(function*() {
      const runtimes = yield* SessionRuntimes
      const sessionId = yield* newSession
      const turnId = yield* newTurnId
      yield* runtimes.startTurn(sessionId, { turnId, text: "fail now" })
      const chunks = yield* untilTurnEnds(sessionId, turnId)

      strictEqual(replyText(chunks), "Partial")
      assertTrue(chunks.some((chunk) => chunk.type === "error"), "expected an error chunk")
      deepStrictEqual(turnEndOf(chunks), { type: "data-turn-end", id: turnId, data: { reason: "failed" } })
    }))

  it.effect("unknown sessions fail before anything is written", () =>
    Effect.gen(function*() {
      const runtimes = yield* SessionRuntimes
      const missing = SessionId.make("00000000-0000-7000-8000-000000000000")
      const turnId = yield* newTurnId
      assertFailure(
        yield* Effect.result(runtimes.startTurn(missing, { turnId, text: "hello?" })),
        SessionNotFound.make({ id: missing })
      )
      strictEqual(yield* statusOf(turnId), undefined)
    }))
})

layer(BunServices.layer, { excludeTestServices: true })("SessionRuntimes across restarts", (it) => {
  it.effect("turns cut off mid-run are recorded as failed on the next start", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped()
      const app = () => appTest({ Q_DB_PATH: path.join(dir, "q.db") })

      // A run that dies with a turn in flight: its row says `running`, its stream has no end.
      const { sessionId, turnId } = yield* Effect.scoped(Effect.gen(function*() {
        const context = yield* Layer.build(app())
        const sql = Context.get(context, SqlClient.SqlClient)
        const session = yield* Context.get(context, Sessions).create({ title: "crash" })
        const inFlight = yield* newTurnId
        const now = DateTime.formatIso(yield* DateTime.now)
        yield* sql`INSERT INTO turns (id, session_id, status, created_at, updated_at)
          VALUES (${inFlight}, ${session.id}, 'running', ${now}, ${now})`
        return { sessionId: session.id, turnId: inFlight }
      }))

      yield* Effect.scoped(Effect.gen(function*() {
        const context = yield* Layer.build(app())
        const streams = Context.get(context, SessionStreams)
        const sql = Context.get(context, SqlClient.SqlClient)
        const { chunks } = yield* streams.catchUp(sessionId, Offset.beginning)
        deepStrictEqual(turnEndOf(chunks), { type: "data-turn-end", id: turnId, data: { reason: "failed" } })
        deepStrictEqual(chunks.at(-2), { type: "error", errorText: "The server stopped during this turn" })
        const rows = yield* sql<{ readonly status: string }>`SELECT status FROM turns WHERE id = ${turnId}`
        assertEquals(rows[0]?.status, "failed")
      }))
    }))

  it.effect("the conversation outlives the server", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped()
      const app = () => appTest({ Q_DB_PATH: path.join(dir, "q.db") })

      const sessionId = yield* Effect.scoped(Effect.gen(function*() {
        const context = yield* Layer.build(app())
        const session = yield* Context.get(context, Sessions).create({ title: "memory" })
        const turnId = yield* newTurnId
        yield* Context.get(context, SessionRuntimes).startTurn(session.id, { turnId, text: "remember me" })
        yield* untilTurnEnds(session.id, turnId).pipe(Effect.provideService(SessionStreams, Context.get(context, SessionStreams)))
        return session.id
      }))

      yield* Effect.scoped(Effect.gen(function*() {
        const context = yield* Layer.build(app())
        const turnId = yield* newTurnId
        yield* Context.get(context, SessionRuntimes).startTurn(sessionId, { turnId, text: "do you?" })
        yield* untilTurnEnds(sessionId, turnId).pipe(Effect.provideService(SessionStreams, Context.get(context, SessionStreams)))
        const prompt = (yield* Context.get(context, FakeAnthropic).prompts).at(-1) ?? []
        deepStrictEqual(prompt.map((message) => [message.role, textOf(message)]), [
          ["user", "remember me"],
          ["assistant", "Echo: remember me"],
          ["user", "do you?"]
        ])
      }))
    }))
})
