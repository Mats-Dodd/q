import { layer } from "@effect/vitest"
import { assertFailure, deepStrictEqual, strictEqual } from "@effect/vitest/utils"
import { Effect, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { RequestInvalid } from "../src/api/ApiErrors.ts"
import { ApiClient } from "../src/client/ApiClient.ts"
import * as Offset from "../src/domain/Offset.ts"
import { SessionId, SessionNotFound } from "../src/domain/Session.ts"
import { NothingToCancel, SessionBusy, type TurnId } from "../src/domain/Turn.ts"
import { ServerTest } from "./support/ServerTest.ts"
import { newMessageId } from "./support/Ids.ts"

const BadRequest = Schema.Struct({ status: Schema.Literal(400), body: RequestInvalid })

const newSession = Effect.gen(function*() {
  const client = yield* ApiClient
  return (yield* client.sessions.create({ payload: { title: "turns api" } })).id
})

/** Every chunk in the session's stream until `turnId` ends, read over SSE like a client would. */
const watchTurn = (id: SessionId, turnId: TurnId) =>
  Effect.gen(function*() {
    const client = yield* ApiClient
    const live = yield* client.sessionStream.read({ params: { id }, query: { offset: Offset.beginning, live: "sse" }, headers: {} })
    if (!Stream.isStream(live)) {
      return yield* Effect.die("expected an SSE stream")
    }
    return yield* live.pipe(
      Stream.flatMap((event) => Stream.fromIterable(event.event === "data" ? event.data : [])),
      Stream.takeUntil((chunk) => chunk.type === "data-turn-end" && chunk.id === turnId),
      Stream.runCollect
    )
  })

// Real time: the model streams in real time, over real HTTP.
layer(ServerTest, { excludeTestServices: true })("Messages API", (it) => {
  it.effect("a message is accepted, and the reply arrives in the session's stream", () =>
    Effect.gen(function*() {
      const client = yield* ApiClient
      const id = yield* newSession

      const [delivery, response] = yield* client.messages.send({
        params: { id },
        payload: { messageId: yield* newMessageId, text: "over the wire" },
        responseMode: "decoded-and-response"
      })
      strictEqual(response.status, 202)
      strictEqual(delivery.disposition, "started")

      const chunks = yield* watchTurn(id, delivery.turnId)
      strictEqual(chunks.map((chunk) => chunk.type === "text-delta" ? chunk.delta : "").join(""), "Echo: over the wire")
      deepStrictEqual(chunks.at(-1), { type: "data-turn-end", id: delivery.turnId, data: { reason: "completed" } })
    }))

  it.effect("resending a message finds the turn it started instead of starting another", () =>
    Effect.gen(function*() {
      const client = yield* ApiClient
      const id = yield* newSession
      const payload = { messageId: yield* newMessageId, text: "slow and steady" }
      const first = yield* client.messages.send({ params: { id }, payload })
      const again = yield* client.messages.send({ params: { id }, payload })
      strictEqual(again.turnId, first.turnId)
      yield* client.messages.cancel({ params: { id } })
    }))

  it.effect("a message while a turn runs is a 409, and cancel frees the session", () =>
    Effect.gen(function*() {
      const client = yield* ApiClient
      const id = yield* newSession
      const slow = yield* client.messages.send({
        params: { id },
        payload: { messageId: yield* newMessageId, text: "slow please" }
      })

      const busy = yield* Effect.result(
        client.messages.send({ params: { id }, payload: { messageId: yield* newMessageId, text: "hi" } })
      )
      assertFailure(busy, SessionBusy.make({ sessionId: id }))

      yield* client.messages.cancel({ params: { id } })
      assertFailure(yield* Effect.result(client.messages.cancel({ params: { id } })), NothingToCancel.make({ sessionId: id }))
      const chunks = yield* watchTurn(id, slow.turnId)
      deepStrictEqual(chunks.at(-1), { type: "data-turn-end", id: slow.turnId, data: { reason: "cancelled" } })
    }))

  it.effect("unknown sessions are a typed 404", () =>
    Effect.gen(function*() {
      const client = yield* ApiClient
      const missing = SessionId.make("00000000-0000-7000-8000-000000000000")
      const result = yield* Effect.result(
        client.messages.send({ params: { id: missing }, payload: { messageId: yield* newMessageId, text: "anyone?" } })
      )
      assertFailure(result, SessionNotFound.make({ id: missing }))
    }))

  it.effect("empty messages and non-UUID message ids are a 400", () =>
    Effect.gen(function*() {
      const http = yield* HttpClient.HttpClient
      const id = yield* newSession
      const messageId = yield* newMessageId
      const invalidAt = (payload: object) =>
        http.execute(HttpClientRequest.post(`/sessions/${id}/messages`).pipe(HttpClientRequest.bodyJsonUnsafe(payload))).pipe(
          Effect.flatMap(HttpClientResponse.schemaJson(BadRequest)),
          Effect.map(({ body }) => body.issues.map((issue) => issue.path))
        )
      deepStrictEqual(yield* invalidAt({ messageId, text: "" }), [["text"]])
      deepStrictEqual(yield* invalidAt({ messageId: "not-a-uuid", text: "hi" }), [["messageId"]])
    }))
})
