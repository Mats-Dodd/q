import { assert, layer } from "@effect/vitest"
import { BunHttpClient } from "@effect/platform-bun"
import { MessageSchema } from "@q/client/program/message"
import type { Message } from "@q/client/program/message"
import type { Model } from "@q/client/program/model"
import { program } from "@q/client/program/program"
import { ApiClient } from "@q/client/transport/api-client"
import { openSession, Transport } from "@q/client/transport/transport-service"
import { IntentSchema, TurnSchema } from "@q/domain/conversation/model"
import { ResumeSchema } from "@q/domain/session/model"
import { textOf } from "@q/factories/conversation-model"
import * as Runtime from "@q/kit/runtime"
import { awaiting, providing } from "@q/test/runtime"
import { Effect, Fiber, Layer, Option, Stream } from "effect"
import { HttpServer } from "effect/unstable/http"
import * as NetAddress from "effect/unstable/net/NetAddress"

import { ServerLayerIntegration } from "./integration-test-layer"

// Over a real socket: Bun's server on an ephemeral port, Bun's fetch as the client. This is the
// one test of the wire itself: JSON in, Server-Sent Events out, through the HTTP transport.

/** The server's URL, as a client on another machine would type it. */
const url = Effect.gen(function* () {
  const server = yield* HttpServer.HttpServer
  const address = server.address
  if (address._tag === "UnixPathAddress") {
    return yield* Effect.die("expected an internet address")
  }
  return (yield* Effect.orDie(Effect.fromResult(NetAddress.toUrl(address)))).origin
})

/** Bun's fetch, plain: the test client `layerTest` provides already knows the server's URL, and a real client does not. */
const httpClient = (base: string) => ApiClient.layerHttp(base).pipe(Layer.provide(BunHttpClient.layer))

const completed = (m: Message) => m._tag === "CompletedRequest"

layer(ServerLayerIntegration, { excludeTestServices: true })("HTTP transport", (it) => {
  it.effect("open, send and watch round-trip over the socket as JSON and SSE", () =>
    Effect.gen(function* () {
      const api = yield* ApiClient
      const session = yield* openSession("/wire", ResumeSchema.cases.New.make({}))
      const transport = Transport.make(api, session.id)

      const models = yield* Stream.runCollect(transport.send(IntentSchema.cases.SubmittedPrompt.make({ text: "ping" })))
      assert.isAtLeast(models.length, 2)
      const last = models.at(-1)
      assert.isDefined(last)
      assert.deepStrictEqual(last.turn, TurnSchema.cases.Idle.make({}))
      assert.deepStrictEqual(last.messages.map(textOf), ["ping", "ping"])
      assert.deepStrictEqual(last.notice, Option.none())

      assert.deepStrictEqual(yield* Stream.runCollect(transport.watch), [last])
      assert.deepStrictEqual(
        (yield* api.sessions.listSessions({ query: { cwd: "/wire" } })).map((s) => s.id),
        [session.id],
      )
    }).pipe(providing(Layer.unwrap(Effect.map(url, httpClient)))),
  )

  it.effect("the client program runs over the HTTP transport", () =>
    Effect.gen(function* () {
      const session = yield* openSession("/wire-program", ResumeSchema.cases.New.make({}))
      const runtime: Runtime.Runtime<Model, Message> = yield* Runtime.make(program).pipe(providing(Transport.layer(session.id)))

      yield* Fiber.join(yield* awaiting(runtime, completed))
      const done = yield* awaiting(runtime, completed)
      runtime.dispatch(MessageSchema.cases.SubmittedPrompt.make({ text: "hey" }))
      yield* Fiber.join(done)
      assert.deepStrictEqual(Option.getOrThrow(runtime.model().remote).messages.map(textOf), ["hey", "hey"])
    }).pipe(providing(Layer.unwrap(Effect.map(url, httpClient)))),
  )

  it.effect("a server that is not there is a notice", () =>
    Effect.gen(function* () {
      const failed = yield* Effect.flip(openSession("/nowhere", ResumeSchema.cases.New.make({})))
      assert.strictEqual(failed._tag, "TransportError")
      assert.include(failed.message, "cannot reach the server")
    }).pipe(providing(httpClient("http://127.0.0.1:1"))),
  )
})
