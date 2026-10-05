import { layer } from "@effect/vitest"
import { assertFailure, deepStrictEqual, strictEqual } from "@effect/vitest/utils"
import { Effect, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { RequestInvalid } from "../src/api/ApiErrors.ts"
import { ApiClient } from "../src/client/ApiClient.ts"
import * as Offset from "../src/domain/Offset.ts"
import { SessionId, SessionNotFound } from "../src/domain/Session.ts"
import { type TurnId, TurnInProgress, TurnNotRunning } from "../src/domain/Turn.ts"
import { ServerTest } from "./support/ServerTest.ts"
import { newTurnId } from "./support/Ids.ts"

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
layer(ServerTest, { excludeTestServices: true })("Turns API", (it) => {
  it.effect("send is accepted, and the reply arrives in the session's stream", () =>
    Effect.gen(function*() {
      const client = yield* ApiClient
      const id = yield* newSession
      const turnId = yield* newTurnId

      const [turn, response] = yield* client.turns.start({
        params: { id },
        payload: { turnId, text: "over the wire" },
        responseMode: "decoded-and-response"
      })
      strictEqual(response.status, 202)
      strictEqual(turn.id, turnId)
      strictEqual(turn.status, "running")

      const chunks = yield* watchTurn(id, turnId)
      strictEqual(chunks.map((chunk) => chunk.type === "text-delta" ? chunk.delta : "").join(""), "Echo: over the wire")
      deepStrictEqual(chunks.at(-1), { type: "data-turn-end", id: turnId, data: { reason: "completed" } })
    }))

  it.effect("resending a turn returns it instead of starting another", () =>
    Effect.gen(function*() {
      const client = yield* ApiClient
      const id = yield* newSession
      const turnId = yield* newTurnId
      const payload = { turnId, text: "slow and steady" }
      const first = yield* client.turns.start({ params: { id }, payload })
      const again = yield* client.turns.start({ params: { id }, payload })
      strictEqual(again.id, first.id)
      yield* client.turns.cancel({ params: { id } })
    }))

  it.effect("a second turn while one runs is a 409, and cancel frees the session", () =>
    Effect.gen(function*() {
      const client = yield* ApiClient
      const id = yield* newSession
      const slow = yield* newTurnId
      yield* client.turns.start({ params: { id }, payload: { turnId: slow, text: "slow please" } })

      const busy = yield* Effect.result(client.turns.start({ params: { id }, payload: { turnId: yield* newTurnId, text: "hi" } }))
      assertFailure(busy, TurnInProgress.make({ sessionId: id }))

      yield* client.turns.cancel({ params: { id } })
      assertFailure(yield* Effect.result(client.turns.cancel({ params: { id } })), TurnNotRunning.make({ sessionId: id }))
      const chunks = yield* watchTurn(id, slow)
      deepStrictEqual(chunks.at(-1), { type: "data-turn-end", id: slow, data: { reason: "cancelled" } })
    }))

  it.effect("unknown sessions are a typed 404", () =>
    Effect.gen(function*() {
      const client = yield* ApiClient
      const missing = SessionId.make("00000000-0000-7000-8000-000000000000")
      const result = yield* Effect.result(
        client.turns.start({ params: { id: missing }, payload: { turnId: yield* newTurnId, text: "anyone?" } })
      )
      assertFailure(result, SessionNotFound.make({ id: missing }))
    }))

  it.effect("empty messages and non-UUID turn ids are a 400", () =>
    Effect.gen(function*() {
      const http = yield* HttpClient.HttpClient
      const id = yield* newSession
      const turnId = yield* newTurnId
      const invalidAt = (payload: object) =>
        http.execute(HttpClientRequest.post(`/sessions/${id}/turns`).pipe(HttpClientRequest.bodyJsonUnsafe(payload))).pipe(
          Effect.flatMap(HttpClientResponse.schemaJson(BadRequest)),
          Effect.map(({ body }) => body.issues.map((issue) => issue.path))
        )
      deepStrictEqual(yield* invalidAt({ turnId, text: "" }), [["text"]])
      deepStrictEqual(yield* invalidAt({ turnId: "not-a-uuid", text: "hi" }), [["turnId"]])
    }))
})
