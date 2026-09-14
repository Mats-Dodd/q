import { assert, it, layer } from "@effect/vitest"
import { BunHttpClient, BunHttpServer } from "@effect/platform-bun"
import { Effect, Fiber, Layer, Option, Stream } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import * as NetAddress from "effect/unstable/net/NetAddress"

import { Agent, Message as Intent, Resume, TranscriptRepository, Turn } from "@q/core"
import { Runtime } from "@q/kit"
import { ApiLayer, Sessions, SessionsHandlers } from "@q/server"
import { Message, type Model, program } from "../src/program"
import { Client, Transport, open } from "../src/transport"

// Over a real socket: Bun's server on an ephemeral port, Bun's fetch as the client. This is the
// one test of the wire itself: JSON in, Server-Sent Events out, through the HTTP transport.

const Server = HttpRouter.serve(ApiLayer, { disableLogger: true }).pipe(
  Layer.provide(SessionsHandlers),
  Layer.provide(Sessions.layer()),
  Layer.provide(Layer.mergeAll(Agent.Echo("1 millis"), TranscriptRepository.Memory)),
  Layer.provideMerge(BunHttpServer.layerTest),
)

/** Bun's fetch, plain: the test client `layerTest` provides already knows the server's URL, and a real client does not. */
const Fetch = BunHttpClient.layer

/** The server's URL, as a client on another machine would type it. */
const url = Effect.gen(function* () {
  const server = yield* HttpServer.HttpServer
  const address = server.address
  if (address._tag === "UnixPathAddress") return yield* Effect.die("expected an internet address")
  return (yield* Effect.orDie(Effect.fromResult(NetAddress.toUrl(address)))).origin
})

const awaiting = (runtime: Runtime.Runtime<Model, Message>, predicate: (message: Message) => boolean) =>
  Effect.forkChild(Stream.runHead(Stream.filter(runtime.messages, predicate)), { startImmediately: true })

layer(Server, { excludeTestServices: true })("HTTP transport", (it) => {
  it.effect("open, send and watch round-trip over the socket as JSON and SSE", () =>
    Effect.gen(function* () {
      const api = yield* Client.http(yield* url).pipe(Effect.provide(Fetch))
      const session = yield* open(api, "/wire", Resume.cases.New.make({}))
      const transport = Transport.fromClient(api, session.id)

      const models = yield* Stream.runCollect(transport.send(Intent.cases.SubmittedPrompt.make({ text: "ping" })))
      assert.isAtLeast(models.length, 2)
      const last = models.at(-1)!
      assert.deepStrictEqual(last.turn, Turn.cases.Idle.make({}))
      assert.deepStrictEqual(last.messages.map((m) => m.text), ["ping", "ping"])
      assert.deepStrictEqual(last.notice, Option.none())

      assert.deepStrictEqual(yield* Stream.runCollect(transport.watch), [last])
      assert.deepStrictEqual((yield* api.sessions.list({ query: { cwd: "/wire" } })).map((s) => s.id), [session.id])
    }),
  )

  it.effect("the client program runs over the HTTP transport", () =>
    Effect.gen(function* () {
      const base = yield* url
      const api = yield* Client.http(base).pipe(Effect.provide(Fetch))
      const session = yield* open(api, "/wire-program", Resume.cases.New.make({}))
      const runtime = yield* Runtime.make(program).pipe(Effect.provide(Transport.Http(base, session.id).pipe(Layer.provide(Fetch))))

      yield* Fiber.join(yield* awaiting(runtime, (m) => m._tag === "CompletedRequest"))
      const done = yield* awaiting(runtime, (m) => m._tag === "CompletedRequest")
      runtime.dispatch(Message.cases.SubmittedPrompt.make({ text: "hey" }))
      yield* Fiber.join(done)
      assert.deepStrictEqual(
        Option.getOrThrow(runtime.model().remote).messages.map((m) => m.text),
        ["hey", "hey"],
      )
    }),
  )

  it.effect("a server that is not there is a notice", () =>
    Effect.gen(function* () {
      const api = yield* Client.http("http://127.0.0.1:1").pipe(Effect.provide(Fetch))
      const failed = yield* Effect.flip(open(api, "/nowhere", Resume.cases.New.make({})))
      assert.strictEqual(failed._tag, "TransportError")
      assert.include(failed.message, "cannot reach the server")
    }),
  )
})
