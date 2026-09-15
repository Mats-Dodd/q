import { assert, layer } from "@effect/vitest"
import { AgentService } from "@q/core/agent/agent-service"
import { type ChatChunk, type ConversationModel, IntentSchema, TurnSchema } from "@q/domain/conversation/model"
import { ResumeSchema } from "@q/domain/session/model"
import { makeEmailApprovalChunks, makeEmailSentChunk, makeTextChunks } from "@q/factories/chat-chunk"
import { textOf } from "@q/factories/conversation-model"
import { makeSessionId } from "@q/factories/session"
import { HttpPlatformLayerTest } from "@q/test/http/platform-layer"
import { Deferred, Effect, Fiber, Layer, Stream } from "effect"

import { makeApiClientIntegration } from "./integration-test-layer"

// The API through an in-memory client: the same encoding, routing and decoding as over a socket,
// without one. Storage is real SQLite on a throwaway database. The clock is real: the echo agent's
// delays are tiny and completion is the end of the SSE stream, never a sleep.

const texts = (model: ConversationModel) => model.messages.map(textOf)

/** An agent that says `first`, then holds until `gate` opens, then says `then`. */
const heldAgent = (gate: Deferred.Deferred<void>, first: string, then: string) =>
  Layer.succeed(
    AgentService,
    AgentService.of({
      step: () =>
        Stream.make<ReadonlyArray<ChatChunk>>(
          { type: "start-step" },
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: first },
        ).pipe(
          Stream.concat(
            Stream.fromEffect(Effect.as(Deferred.await(gate), { type: "text-delta", id: "t", delta: then } satisfies ChatChunk)),
          ),
          Stream.concat(Stream.make<ReadonlyArray<ChatChunk>>({ type: "text-end", id: "t" }, { type: "finish-step" })),
        ),
    }),
  )

layer(HttpPlatformLayerTest, { excludeTestServices: true })("sessions API", (it) => {
  it.effect("a session is opened, a prompt streams Models until idle, and the result is durable", () =>
    Effect.gen(function* () {
      const api = yield* makeApiClientIntegration(AgentService.layerEcho("1 millis"))
      const session = yield* api.sessions.openSession({ payload: { cwd: "/a", resume: ResumeSchema.cases.New.make({}) } })

      const models = yield* Stream.runCollect(
        yield* api.sessions.sendIntent({ params: { id: session.id }, payload: IntentSchema.cases.SubmittedPrompt.make({ text: "hello" }) }),
      )
      assert.isAtLeast(models.length, 2)
      assert.isTrue(models.slice(0, -1).every((m) => m.turn._tag !== "Idle"))
      const last = models.at(-1)!
      assert.deepStrictEqual(last.turn, TurnSchema.cases.Idle.make({}))
      assert.deepStrictEqual(texts(last), ["hello", "hello"])

      // Watching an idle session is one Model: the current one.
      assert.deepStrictEqual(yield* Stream.runCollect(yield* api.sessions.watchSession({ params: { id: session.id } })), [last])

      assert.deepStrictEqual(
        (yield* api.sessions.listSessions({ query: { cwd: "/a" } })).map((s) => s.id),
        [session.id],
      )
      assert.deepStrictEqual(yield* api.sessions.listSessions({ query: { cwd: "/elsewhere" } }), [])
      assert.deepStrictEqual(
        yield* api.sessions.openSession({ payload: { cwd: "/a", resume: ResumeSchema.cases.Latest.make({}) } }),
        session,
      )
      assert.deepStrictEqual(
        yield* api.sessions.openSession({ payload: { cwd: "/a", resume: ResumeSchema.cases.Session.make({ id: session.id }) } }),
        session,
      )
    }),
  )

  it.effect("an unknown session is SessionNotFoundError on every route that names one", () =>
    Effect.gen(function* () {
      const api = yield* makeApiClientIntegration(AgentService.layerEcho(null))
      const id = makeSessionId("nope")
      const opened = yield* Effect.flip(
        api.sessions.openSession({ payload: { cwd: "/a", resume: ResumeSchema.cases.Session.make({ id }) } }),
      )
      assert.strictEqual(opened._tag, "SessionNotFoundError")
      const watched = yield* Effect.flip(api.sessions.watchSession({ params: { id } }))
      assert.strictEqual(watched._tag, "SessionNotFoundError")
      const sent = yield* Effect.flip(api.sessions.sendIntent({ params: { id }, payload: IntentSchema.cases.PressedEscape.make({}) }))
      assert.strictEqual(sent._tag, "SessionNotFoundError")
    }),
  )

  it.effect("escape from a second request ends the turn the first request is streaming", () =>
    Effect.gen(function* () {
      // The agent says "a", then holds until the gate opens, which this test never does.
      const gate = yield* Deferred.make<void>()
      const api = yield* makeApiClientIntegration(heldAgent(gate, "a", "b"))
      const session = yield* api.sessions.openSession({ payload: { cwd: "/b", resume: ResumeSchema.cases.New.make({}) } })

      const turn = yield* Effect.forkChild(
        Stream.runCollect(
          yield* api.sessions.sendIntent({ params: { id: session.id }, payload: IntentSchema.cases.SubmittedPrompt.make({ text: "hi" }) }),
        ),
        { startImmediately: true },
      )
      // A watcher sees the "a" land; only then is escape meaningful.
      yield* Stream.runHead(
        Stream.filter(yield* api.sessions.watchSession({ params: { id: session.id } }), (m) => textOf(m.messages[1]) === "a"),
      )

      const escaped = yield* Stream.runCollect(
        yield* api.sessions.sendIntent({ params: { id: session.id }, payload: IntentSchema.cases.PressedEscape.make({}) }),
      )
      assert.strictEqual(escaped.length, 1)
      assert.deepStrictEqual(escaped[0]!.turn, TurnSchema.cases.Idle.make({}))
      assert.deepStrictEqual(texts(escaped[0]!), ["hi", "a"])

      const models = yield* Fiber.join(turn)
      assert.deepStrictEqual(models.at(-1)!.turn, TurnSchema.cases.Idle.make({}))
      assert.deepStrictEqual(texts(models.at(-1)!), ["hi", "a"])
    }),
  )

  it.effect("a prompt while a turn is running is ignored; the stream still ends with the turn", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const api = yield* makeApiClientIntegration(heldAgent(gate, "", "done"))
      const session = yield* api.sessions.openSession({ payload: { cwd: "/c", resume: ResumeSchema.cases.New.make({}) } })

      const first = yield* Effect.forkChild(
        Stream.runCollect(
          yield* api.sessions.sendIntent({ params: { id: session.id }, payload: IntentSchema.cases.SubmittedPrompt.make({ text: "one" }) }),
        ),
        { startImmediately: true },
      )
      yield* Stream.runHead(
        Stream.filter(yield* api.sessions.watchSession({ params: { id: session.id } }), (m) => m.turn._tag === "Streaming"),
      )

      const second = yield* Effect.forkChild(
        Stream.runCollect(
          yield* api.sessions.sendIntent({ params: { id: session.id }, payload: IntentSchema.cases.SubmittedPrompt.make({ text: "two" }) }),
        ),
        { startImmediately: true },
      )
      yield* Deferred.succeed(gate, undefined)

      for (const models of [yield* Fiber.join(first), yield* Fiber.join(second)]) {
        assert.deepStrictEqual(texts(models.at(-1)!), ["one", "done"])
        assert.deepStrictEqual(models.at(-1)!.turn, TurnSchema.cases.Idle.make({}))
      }
    }),
  )

  it.effect("an approval request ends the response; the answer is a request that runs the turn to its end", () =>
    Effect.gen(function* () {
      const api = yield* makeApiClientIntegration(
        AgentService.layerScripted([
          makeEmailApprovalChunks("call-1", "approval-1"),
          [makeEmailSentChunk("call-1"), ...makeTextChunks("Sent.")],
        ]),
      )
      const session = yield* api.sessions.openSession({ payload: { cwd: "/d", resume: ResumeSchema.cases.New.make({}) } })

      const parked = yield* Stream.runCollect(
        yield* api.sessions.sendIntent({
          params: { id: session.id },
          payload: IntentSchema.cases.SubmittedPrompt.make({ text: "email bob" }),
        }),
      )
      assert.deepStrictEqual(parked.at(-1)!.turn, TurnSchema.cases.AwaitingApproval.make({ messageId: "1", round: 0 }))
      // Watching a parked session is one Model too.
      assert.deepStrictEqual(yield* Stream.runCollect(yield* api.sessions.watchSession({ params: { id: session.id } })), [parked.at(-1)!])

      const resumed = yield* Stream.runCollect(
        yield* api.sessions.sendIntent({
          params: { id: session.id },
          payload: IntentSchema.cases.RespondedToolApproval.make({ toolCallId: "call-1", approved: true }),
        }),
      )
      const last = resumed.at(-1)!
      assert.deepStrictEqual(last.turn, TurnSchema.cases.Idle.make({}))
      assert.deepStrictEqual(texts(last), ["email bob", "Sent."])
      assert.deepStrictEqual(
        last.messages[1]!.parts.map((p) => p.type),
        ["step-start", "tool-send_email", "step-start", "text"],
      )
    }),
  )
})
