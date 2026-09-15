import { assert, it, layer } from "@effect/vitest"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Deferred, Effect, Fiber, FileSystem, Layer, Path, Stream } from "effect"
import { Etag, HttpPlatform } from "effect/unstable/http"
import { HttpApiTest } from "effect/unstable/httpapi"

import { Agent, Api, Message, Resume, SessionId, Turn } from "@q/core"
import { Sql } from "@q/db"
import { SessionsHandlers } from "../src/api"
import { Sessions } from "../src/sessions"

// The API through an in-memory client: the same encoding, routing and decoding as over a socket,
// without one. Storage is real SQLite on a throwaway database. The clock is real: the echo agent's
// delays are tiny and completion is the end of the SSE stream, never a sleep.

const Services = Layer.mergeAll(Path.layer, Etag.layerWeak, HttpPlatform.layer).pipe(Layer.provideMerge(FileSystem.layerNoop({})))

/** A client over a fresh server: its own sessions, its own database, the given agent. Lives in the test's Scope. */
const client = (agent: Layer.Layer<Agent>) =>
  Effect.gen(function* () {
    const server = yield* Layer.build(
      SessionsHandlers.pipe(Layer.provide(Sessions.layer()), Layer.provide(Layer.mergeAll(agent, Sqlite))),
    )
    return yield* HttpApiTest.groups(Api, ["sessions"]).pipe(Effect.provide(server))
  })

const Sqlite = Sql.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))

const texts = (model: { readonly messages: ReadonlyArray<{ readonly text: string }> }) => model.messages.map((m) => m.text)

layer(Services, { excludeTestServices: true })("Api", (it) => {
  it.effect("a session is opened, a prompt streams Models until idle, and the result is durable", () =>
    Effect.gen(function* () {
      const api = yield* client(Agent.Echo("1 millis"))
      const session = yield* api.sessions.open({ payload: { cwd: "/a", resume: Resume.cases.New.make({}) } })

      const models = yield* Stream.runCollect(
        yield* api.sessions.send({ params: { id: session.id }, payload: Message.cases.SubmittedPrompt.make({ text: "hello" }) }),
      )
      assert.isAtLeast(models.length, 2)
      assert.isTrue(models.slice(0, -1).every((m) => m.turn._tag !== "Idle"))
      const last = models.at(-1)!
      assert.deepStrictEqual(last.turn, Turn.cases.Idle.make({}))
      assert.deepStrictEqual(texts(last), ["hello", "hello"])

      // Watching an idle session is one Model: the current one.
      assert.deepStrictEqual(yield* Stream.runCollect(yield* api.sessions.watch({ params: { id: session.id } })), [last])

      assert.deepStrictEqual((yield* api.sessions.list({ query: { cwd: "/a" } })).map((s) => s.id), [session.id])
      assert.deepStrictEqual(yield* api.sessions.list({ query: { cwd: "/elsewhere" } }), [])
      assert.deepStrictEqual(yield* api.sessions.open({ payload: { cwd: "/a", resume: Resume.cases.Latest.make({}) } }), session)
      assert.deepStrictEqual(yield* api.sessions.open({ payload: { cwd: "/a", resume: Resume.cases.Session.make({ id: session.id }) } }), session)
    }),
  )

  it.effect("an unknown session is SessionNotFound on every route that names one", () =>
    Effect.gen(function* () {
      const api = yield* client(Agent.Echo(null))
      const id = SessionId.make("nope")
      const opened = yield* Effect.flip(api.sessions.open({ payload: { cwd: "/a", resume: Resume.cases.Session.make({ id }) } }))
      assert.strictEqual(opened._tag, "SessionNotFound")
      const watched = yield* Effect.flip(api.sessions.watch({ params: { id } }))
      assert.strictEqual(watched._tag, "SessionNotFound")
      const sent = yield* Effect.flip(api.sessions.send({ params: { id }, payload: Message.cases.PressedEscape.make({}) }))
      assert.strictEqual(sent._tag, "SessionNotFound")
    }),
  )

  it.effect("escape from a second request ends the turn the first request is streaming", () =>
    Effect.gen(function* () {
      // The agent says "a", then holds until the gate opens, which this test never does.
      const gate = yield* Deferred.make<void>()
      const held = Layer.succeed(Agent)({
        stream: () => Stream.concat(Stream.make("a"), Stream.fromEffect(Effect.as(Deferred.await(gate), "b"))),
      })
      const api = yield* client(held)
      const session = yield* api.sessions.open({ payload: { cwd: "/b", resume: Resume.cases.New.make({}) } })

      const turn = yield* Effect.forkChild(
        Stream.runCollect(
          yield* api.sessions.send({ params: { id: session.id }, payload: Message.cases.SubmittedPrompt.make({ text: "hi" }) }),
        ),
        { startImmediately: true },
      )
      // A watcher sees the "a" land; only then is escape meaningful.
      yield* Stream.runHead(Stream.filter(yield* api.sessions.watch({ params: { id: session.id } }), (m) => m.messages[1]?.text === "a"))

      const escaped = yield* Stream.runCollect(
        yield* api.sessions.send({ params: { id: session.id }, payload: Message.cases.PressedEscape.make({}) }),
      )
      assert.strictEqual(escaped.length, 1)
      assert.deepStrictEqual(escaped[0]!.turn, Turn.cases.Idle.make({}))
      assert.deepStrictEqual(texts(escaped[0]!), ["hi", "a"])

      const models = yield* Fiber.join(turn)
      assert.deepStrictEqual(models.at(-1)!.turn, Turn.cases.Idle.make({}))
      assert.deepStrictEqual(texts(models.at(-1)!), ["hi", "a"])
    }),
  )

  it.effect("a prompt while a turn is running is ignored; the stream still ends with the turn", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const held = Layer.succeed(Agent)({
        stream: () => Stream.fromEffect(Effect.as(Deferred.await(gate), "done")),
      })
      const api = yield* client(held)
      const session = yield* api.sessions.open({ payload: { cwd: "/c", resume: Resume.cases.New.make({}) } })

      const first = yield* Effect.forkChild(
        Stream.runCollect(yield* api.sessions.send({ params: { id: session.id }, payload: Message.cases.SubmittedPrompt.make({ text: "one" }) })),
        { startImmediately: true },
      )
      yield* Stream.runHead(Stream.filter(yield* api.sessions.watch({ params: { id: session.id } }), (m) => m.turn._tag === "Streaming"))

      const second = yield* Effect.forkChild(
        Stream.runCollect(yield* api.sessions.send({ params: { id: session.id }, payload: Message.cases.SubmittedPrompt.make({ text: "two" }) })),
        { startImmediately: true },
      )
      yield* Deferred.succeed(gate, undefined)

      for (const models of [yield* Fiber.join(first), yield* Fiber.join(second)]) {
        assert.deepStrictEqual(texts(models.at(-1)!), ["one", "done"])
        assert.deepStrictEqual(models.at(-1)!.turn, Turn.cases.Idle.make({}))
      }
    }),
  )
})
