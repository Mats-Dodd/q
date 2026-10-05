import { layer } from "@effect/vitest"
import { assertFailure, assertTrue, deepStrictEqual, strictEqual } from "@effect/vitest/utils"
import { Deferred, Effect, Fiber, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { RequestInvalid } from "../src/api/ApiErrors.ts"
import { ApiClient } from "../src/client/ApiClient.ts"
import * as Offset from "../src/domain/Offset.ts"
import { SessionId, SessionNotFound } from "../src/domain/Session.ts"
import type { StreamChunk } from "../src/domain/StreamChunk.ts"
import { appendEvents, output } from "./support/Events.ts"
import { ServerTest } from "./support/ServerTest.ts"

const missing = SessionId.make("00000000-0000-7000-8000-000000000000")

/** The chunk an `output(text)` event projects to. */
const delta = (text: string): StreamChunk => ({ type: "text-delta", id: "t0", delta: text })

/** A 400 response whose body is a `RequestInvalid`. */
const BadRequest = Schema.Struct({ status: Schema.Literal(400), body: RequestInvalid })

/** A session whose log holds one model output event per text. */
const sessionWith = (...texts: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const client = yield* ApiClient
    const { id } = yield* client.sessions.create({ payload: { title: "stream api" } })
    const [first, ...rest] = texts.map((text) => output(text))
    if (first !== undefined) {
      yield* appendEvents(id, [first, ...rest])
    }
    return id
  })

/** Opens the session's SSE stream; returns once the first event (the catch-up's control) has arrived. */
const openLive = (id: SessionId, events: number) =>
  Effect.gen(function*() {
    const client = yield* ApiClient
    const live = yield* client.sessionStream.read({ params: { id }, query: { offset: Offset.beginning, live: "sse" }, headers: {} })
    if (!Stream.isStream(live)) {
      return yield* Effect.die("expected an SSE stream")
    }
    const connected = yield* Deferred.make<void>()
    const reader = yield* live.pipe(
      Stream.tap(() => Deferred.succeed(connected, undefined)),
      Stream.take(events),
      Stream.runCollect,
      Effect.forkChild
    )
    yield* Deferred.await(connected)
    return reader
  })

layer(ServerTest)("Session stream API", (it) => {
  it.effect("catch-up returns every chunk and the next offset", () =>
    Effect.gen(function*() {
      const http = yield* HttpClient.HttpClient
      const id = yield* sessionWith("a", "b")
      const response = yield* http.get(`/sessions/${id}/stream?offset=-1`)
      strictEqual(response.status, 200)
      strictEqual(response.headers["content-type"], "application/json")
      strictEqual(response.headers["stream-next-offset"], "0000000000000002")
      strictEqual(response.headers["stream-up-to-date"], "true")
      assertTrue(response.headers.etag !== undefined, "missing ETag")
      deepStrictEqual(yield* response.json, [delta("a"), delta("b")])
    }))

  it.effect("no offset reads from the start", () =>
    Effect.gen(function*() {
      const http = yield* HttpClient.HttpClient
      const id = yield* sessionWith("a")
      const implicit = yield* http.get(`/sessions/${id}/stream`).pipe(Effect.flatMap((response) => response.json))
      const explicit = yield* http.get(`/sessions/${id}/stream?offset=-1`).pipe(Effect.flatMap((response) => response.json))
      deepStrictEqual(implicit, explicit)
    }))

  it.effect("reading from the returned offset resumes without duplicates", () =>
    Effect.gen(function*() {
      const http = yield* HttpClient.HttpClient
      const id = yield* sessionWith("a")
      const first = yield* http.get(`/sessions/${id}/stream`)
      const next = first.headers["stream-next-offset"]
      yield* appendEvents(id, [output("b")])
      const resumed = yield* http.get(`/sessions/${id}/stream?offset=${next}`)
      deepStrictEqual(yield* resumed.json, [delta("b")])
    }))

  it.effect("a matching If-None-Match is a 304", () =>
    Effect.gen(function*() {
      const http = yield* HttpClient.HttpClient
      const id = yield* sessionWith("a")
      const first = yield* http.get(`/sessions/${id}/stream`)
      const etag = first.headers.etag ?? ""
      const again = yield* http.execute(
        HttpClientRequest.get(`/sessions/${id}/stream`).pipe(HttpClientRequest.setHeader("if-none-match", etag))
      )
      strictEqual(again.status, 304)
      const other = yield* http.execute(
        HttpClientRequest.get(`/sessions/${id}/stream`).pipe(HttpClientRequest.setHeader("if-none-match", "\"stale\""))
      )
      strictEqual(other.status, 200)
    }))

  it.effect("offset=now is an empty, uncacheable read of the end", () =>
    Effect.gen(function*() {
      const http = yield* HttpClient.HttpClient
      const id = yield* sessionWith("history")
      const response = yield* http.get(`/sessions/${id}/stream?offset=now`)
      strictEqual(response.status, 200)
      deepStrictEqual(yield* response.json, [])
      strictEqual(response.headers["stream-next-offset"], "0000000000000001")
      strictEqual(response.headers["stream-up-to-date"], "true")
      assertTrue(response.headers["cache-control"]?.includes("no-store") === true, "expected no-store")
    }))

  it.effect("HEAD returns the next offset without a body", () =>
    Effect.gen(function*() {
      const http = yield* HttpClient.HttpClient
      const id = yield* sessionWith("a", "b", "c")
      const response = yield* http.execute(HttpClientRequest.head(`/sessions/${id}/stream`))
      strictEqual(response.status, 200)
      strictEqual(response.headers["stream-next-offset"], "0000000000000003")
      strictEqual(yield* response.text, "")
    }))

  it.effect("unknown sessions are a typed 404 in every mode", () =>
    Effect.gen(function*() {
      const client = yield* ApiClient
      const http = yield* HttpClient.HttpClient
      const notFound = SessionNotFound.make({ id: missing })
      const params = { id: missing }
      assertFailure(yield* Effect.result(client.sessionStream.read({ params, query: {}, headers: {} })), notFound)
      assertFailure(
        yield* Effect.result(client.sessionStream.read({ params, query: { offset: "now", live: "sse" }, headers: {} })),
        notFound
      )
      strictEqual((yield* http.execute(HttpClientRequest.head(`/sessions/${missing}/stream`))).status, 404)
    }))

  it.effect("malformed offsets are a 400", () =>
    Effect.gen(function*() {
      const http = yield* HttpClient.HttpClient
      const id = yield* sessionWith()
      for (const offset of ["0,1", "1%202", "abc", "12"]) {
        const { body } = yield* http.get(`/sessions/${id}/stream?offset=${offset}`).pipe(
          Effect.flatMap(HttpClientResponse.schemaJson(BadRequest))
        )
        strictEqual(body.location, "Query")
      }
    }))

  it.effect("live reads require an offset", () =>
    Effect.gen(function*() {
      const http = yield* HttpClient.HttpClient
      const id = yield* sessionWith()
      const { body } = yield* http.get(`/sessions/${id}/stream?live=sse`).pipe(
        Effect.flatMap(HttpClientResponse.schemaJson(BadRequest))
      )
      deepStrictEqual(body.issues.map((issue) => issue.path), [["offset"]])
    }))

  it.effect("SSE is uncached text/event-stream", () =>
    Effect.gen(function*() {
      const client = yield* ApiClient
      const id = yield* sessionWith("a")
      const [, response] = yield* client.sessionStream.read({
        params: { id },
        query: { offset: Offset.beginning, live: "sse" },
        headers: {},
        responseMode: "decoded-and-response"
      })
      strictEqual(response.headers["content-type"], "text/event-stream")
      strictEqual(response.headers["cache-control"], "no-cache")
      strictEqual(response.headers["content-length"], undefined)
    }))

  it.effect("SSE catch-up: every data event is followed by a control event", () =>
    Effect.gen(function*() {
      const id = yield* sessionWith("a", "b")
      const [data, control] = yield* Fiber.join(yield* openLive(id, 2))
      deepStrictEqual(data, { event: "data", data: [delta("a"), delta("b")] })
      strictEqual(control?.event, "control")
      if (control?.event === "control") {
        strictEqual(control.data.streamNextOffset, Offset.Offset.make(2))
        strictEqual(control.data.upToDate, true)
        assertTrue(control.data.streamCursor !== undefined, "missing streamCursor")
      }
    }))

  it.effect("SSE on an empty stream is a control event at the start", () =>
    Effect.gen(function*() {
      const id = yield* sessionWith()
      const [control] = yield* Fiber.join(yield* openLive(id, 1))
      deepStrictEqual(control?.event === "control" && control.data.streamNextOffset, Offset.beginning)
    }))

  it.effect("SSE delivers appends as they happen", () =>
    Effect.gen(function*() {
      const id = yield* sessionWith()
      const reader = yield* openLive(id, 3)
      yield* appendEvents(id, [output("live")])
      const [, data, control] = yield* Fiber.join(reader)
      deepStrictEqual(data, { event: "data", data: [delta("live")] })
      strictEqual(control?.event === "control" && control.data.streamNextOffset, Offset.Offset.make(1))
    }))
})
