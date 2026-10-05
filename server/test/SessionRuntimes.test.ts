import { BunServices } from "@effect/platform-bun"
import { layer } from "@effect/vitest"
import { assertFailure, assertTrue, deepStrictEqual, strictEqual } from "@effect/vitest/utils"
import { Context, Effect, FileSystem, Layer, Path, Stream } from "effect"
import * as Offset from "../src/domain/Offset.ts"
import { SessionId, SessionNotFound } from "../src/domain/Session.ts"
import type { StreamChunk } from "../src/domain/StreamChunk.ts"
import { NothingToCancel, SessionBusy, type TurnId } from "../src/domain/Turn.ts"
import { SessionEventLog } from "../src/services/SessionEventLog.ts"
import { SessionRuntimes } from "../src/services/SessionRuntimes.ts"
import { Sessions } from "../src/services/Sessions.ts"
import { SessionStreams } from "../src/services/SessionStreams.ts"
import { appTest, AppTest } from "./support/AppTest.ts"
import { turnId as cutOffTurn, turnStarted } from "./support/Events.ts"
import { FakeAnthropic, textOf } from "./support/FakeAnthropic.ts"
import { newMessageId } from "./support/Ids.ts"

const newSession = Effect.gen(function*() {
  const sessions = yield* Sessions
  return (yield* sessions.create({ title: "agent" })).id
})

/** Sends `text` as a new message, returning the turn it started. */
const send = (sessionId: SessionId, text: string) =>
  Effect.gen(function*() {
    const runtimes = yield* SessionRuntimes
    const delivery = yield* runtimes.sendMessage(sessionId, { messageId: yield* newMessageId, text })
    return delivery.turnId
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

// Real time: the model streams in real time, over real HTTP.
layer(AppTest, { excludeTestServices: true })("SessionRuntimes", (it) => {
  it.effect("a turn streams the user's message, then the model's reply, then its end", () =>
    Effect.gen(function*() {
      const sessionId = yield* newSession
      const turnId = yield* send(sessionId, "hello there")
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
    }))

  it.effect("the model sees the whole conversation", () =>
    Effect.gen(function*() {
      const fake = yield* FakeAnthropic
      const sessionId = yield* newSession
      yield* untilTurnEnds(sessionId, yield* send(sessionId, "one"))
      yield* untilTurnEnds(sessionId, yield* send(sessionId, "two"))

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
      yield* send(sessionId, "slow please")
      yield* untilReplying(sessionId)
      yield* runtimes.cancel(sessionId)
      yield* untilTurnEnds(sessionId, yield* send(sessionId, "overloaded"))
      yield* untilTurnEnds(sessionId, yield* send(sessionId, "and now?"))

      // The failed turn left no reply, so its message and the next reach the model
      // together (the provider merges consecutive user messages).
      const prompt = (yield* fake.prompts).at(-1) ?? []
      deepStrictEqual(prompt.map((message) => message.role), ["user", "assistant", "user"])
      assertTrue(textOf(prompt[1] ?? { role: "", content: "" }).startsWith("."), "the partial reply")
      strictEqual(textOf(prompt[2] ?? { role: "", content: "" }), "overloadedand now?")
    }))

  it.effect("sending the same message again does not start another turn", () =>
    Effect.gen(function*() {
      const runtimes = yield* SessionRuntimes
      const fake = yield* FakeAnthropic
      const sessionId = yield* newSession
      const messageId = yield* newMessageId
      const promptsBefore = (yield* fake.prompts).length

      const first = yield* runtimes.sendMessage(sessionId, { messageId, text: "once" })
      const retried = yield* runtimes.sendMessage(sessionId, { messageId, text: "once" })
      strictEqual(retried.turnId, first.turnId)
      const chunks = yield* untilTurnEnds(sessionId, first.turnId)
      // Retrying after it finished still finds the turn it started.
      strictEqual((yield* runtimes.sendMessage(sessionId, { messageId, text: "once" })).turnId, first.turnId)

      strictEqual(chunks.filter((chunk) => chunk.type === "data-user-message").length, 1)
      strictEqual((yield* fake.prompts).length, promptsBefore + 1)
    }))

  it.effect("one turn at a time per session", () =>
    Effect.gen(function*() {
      const runtimes = yield* SessionRuntimes
      const sessionId = yield* newSession
      yield* send(sessionId, "slow please")

      assertFailure(yield* Effect.result(send(sessionId, "me too")), SessionBusy.make({ sessionId }))

      // Other sessions are unaffected.
      const elsewhere = yield* newSession
      yield* untilTurnEnds(elsewhere, yield* send(elsewhere, "hi"))
      yield* runtimes.cancel(sessionId)
    }))

  it.effect("cancelling interrupts the model and records it", () =>
    Effect.gen(function*() {
      const runtimes = yield* SessionRuntimes
      const sessionId = yield* newSession
      const turnId = yield* send(sessionId, "slow please")
      yield* untilReplying(sessionId)

      yield* runtimes.cancel(sessionId)
      const chunks = yield* untilTurnEnds(sessionId, turnId)
      deepStrictEqual(chunks.slice(-2), [
        { type: "abort", reason: "cancelled" },
        { type: "data-turn-end", id: turnId, data: { reason: "cancelled" } }
      ])
      assertTrue(replyText(chunks).length < 40, "the reply was cut short")

      assertFailure(yield* Effect.result(runtimes.cancel(sessionId)), NothingToCancel.make({ sessionId }))
      // The session is free again.
      const next = yield* send(sessionId, "again")
      strictEqual(turnEndOf(yield* untilTurnEnds(sessionId, next))?.type, "data-turn-end")
    }))

  it.effect("a model that fails before replying fails the turn", () =>
    Effect.gen(function*() {
      const sessionId = yield* newSession
      const turnId = yield* send(sessionId, "overloaded")
      const chunks = yield* untilTurnEnds(sessionId, turnId)

      strictEqual(chunks.at(-2)?.type, "error")
      deepStrictEqual(turnEndOf(chunks), { type: "data-turn-end", id: turnId, data: { reason: "failed" } })
    }))

  it.effect("a model that fails mid-reply keeps what it said and fails the turn", () =>
    Effect.gen(function*() {
      const sessionId = yield* newSession
      const turnId = yield* send(sessionId, "fail now")
      const chunks = yield* untilTurnEnds(sessionId, turnId)

      strictEqual(replyText(chunks), "Partial")
      assertTrue(chunks.some((chunk) => chunk.type === "error"), "expected an error chunk")
      deepStrictEqual(turnEndOf(chunks), { type: "data-turn-end", id: turnId, data: { reason: "failed" } })
    }))

  it.effect("unknown sessions are refused", () =>
    Effect.gen(function*() {
      const missing = SessionId.make("00000000-0000-7000-8000-000000000000")
      assertFailure(yield* Effect.result(send(missing, "hello?")), SessionNotFound.make({ id: missing }))
    }))
})

layer(BunServices.layer, { excludeTestServices: true })("SessionRuntimes across restarts", (it) => {
  it.effect("a turn cut off mid-run is recorded as failed on the next start", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped()
      const app = () => appTest({ Q_DB_PATH: path.join(dir, "q.db") })

      // A run that dies mid-turn: the turn started, and never ended.
      const sessionId = yield* Effect.scoped(Effect.gen(function*() {
        const context = yield* Layer.build(app())
        const session = yield* Context.get(context, Sessions).create({ title: "crash" })
        yield* Context.get(context, SessionEventLog).append(session.id, 0, [turnStarted("hi")])
        return session.id
      }))

      yield* Effect.scoped(Effect.gen(function*() {
        const context = yield* Layer.build(app())
        const { chunks } = yield* Context.get(context, SessionStreams).catchUp(sessionId, Offset.beginning)
        deepStrictEqual(chunks.slice(-2), [
          { type: "error", errorText: "The server stopped during this turn" },
          { type: "data-turn-end", id: cutOffTurn, data: { reason: "failed" } }
        ])
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
        const turnId = yield* send(session.id, "remember me").pipe(Effect.provideContext(context))
        yield* untilTurnEnds(session.id, turnId).pipe(Effect.provideContext(context))
        return session.id
      }))

      yield* Effect.scoped(Effect.gen(function*() {
        const context = yield* Layer.build(app())
        const turnId = yield* send(sessionId, "do you?").pipe(Effect.provideContext(context))
        yield* untilTurnEnds(sessionId, turnId).pipe(Effect.provideContext(context))
        const prompt = (yield* Context.get(context, FakeAnthropic).prompts).at(-1) ?? []
        deepStrictEqual(prompt.map((message) => [message.role, textOf(message)]), [
          ["user", "remember me"],
          ["assistant", "Echo: remember me"],
          ["user", "do you?"]
        ])
      }))
    }))
})
