import { assert, it, layer } from "@effect/vitest"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Fiber, FileSystem, Layer, Option, Path, Stream } from "effect"
import { Etag, HttpPlatform } from "effect/unstable/http"

import { Agent, Resume, Turn } from "@q/core"
import { Sql } from "@q/db"
import { Runtime } from "@q/kit"
import { Sessions, SessionsHandlers } from "@q/server"
import { Message, type Model, program } from "../src/program"
import { Client, Transport, open } from "../src/transport"

// The client program against a real server in the same process, through the local transport: the
// same encoding and routing as HTTP. The clock is real; completion is a message on the runtime.

const Platform = Layer.mergeAll(Path.layer, Etag.layerWeak, HttpPlatform.layer).pipe(Layer.provideMerge(FileSystem.layerNoop({})))
const Server = SessionsHandlers.pipe(Layer.provide(Sessions.layer()), Layer.provide(Layer.mergeAll(Agent.Echo("1 millis"), Sql.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" }))))))

const remote = (runtime: Runtime.Runtime<Model, Message>) => Option.getOrThrow(runtime.model().remote)

/** Fork a wait for the first Message that satisfies `predicate`. Fork before the dispatch, join after. */
const awaiting = (runtime: Runtime.Runtime<Model, Message>, predicate: (message: Message) => boolean) =>
  Effect.forkChild(Stream.runHead(Stream.filter(runtime.messages, predicate)), { startImmediately: true })

const completed = (m: Message) => m._tag === "CompletedRequest"

layer(Layer.mergeAll(Platform, Server), { excludeTestServices: true })("client program", (it) => {
  it.effect("boot mirrors the session; a prompt streams the turn into the mirror; a new client sees the same", () =>
    Effect.gen(function* () {
      const api = yield* Client.local
      const session = yield* open(api, "/a", Resume.cases.New.make({}))

      const runtime = yield* Runtime.make(program).pipe(Effect.provide(Transport.Local(session.id)))
      assert.deepStrictEqual(runtime.model().remote, Option.none())
      yield* Fiber.join(yield* awaiting(runtime, completed))
      assert.deepStrictEqual(remote(runtime).messages, [])

      const done = yield* awaiting(runtime, completed)
      runtime.dispatch(Message.cases.SubmittedPrompt.make({ text: "hello" }))
      assert.deepStrictEqual(runtime.model().pending, Option.some("hello"))
      yield* Fiber.join(done)
      assert.deepStrictEqual(runtime.model().pending, Option.none())
      assert.deepStrictEqual(remote(runtime).turn, Turn.cases.Idle.make({}))
      assert.deepStrictEqual(
        remote(runtime).messages.map((m) => m.text),
        ["hello", "hello"],
      )

      const other = yield* Runtime.make(program).pipe(Effect.provide(Transport.Local(session.id)))
      yield* Fiber.join(yield* awaiting(other, completed))
      assert.deepStrictEqual(other.model().remote, runtime.model().remote)
    }),
  )

  it.effect("a session that is gone is a notice, not a crash", () =>
    Effect.gen(function* () {
      const api = yield* Client.local
      const session = yield* open(api, "/b", Resume.cases.New.make({}))
      const runtime = yield* Runtime.make(program).pipe(Effect.provide(Transport.Local(`${session.id}-gone` as typeof session.id)))
      yield* Fiber.join(yield* awaiting(runtime, (m) => m._tag === "FailedRequest"))
      assert.deepStrictEqual(runtime.model().notice, Option.some("the session is gone"))
      assert.isFalse(runtime.crashed())
    }),
  )
})
