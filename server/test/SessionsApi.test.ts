import { layer } from "@effect/vitest"
import { assertEquals, assertFailure, assertTrue, deepStrictEqual, strictEqual } from "@effect/vitest/utils"
import { Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { HttpApiError } from "effect/http-api"
import { SqlClient } from "effect/sql"
import { RequestInvalid } from "../src/api/ApiErrors.ts"
import { ApiClient } from "../src/client/ApiClient.ts"
import { SessionId, SessionNotFound } from "../src/domain/Session.ts"
import { ServerTest } from "./support/ServerTest.ts"

/** A 400 response whose body is a `RequestInvalid`. */
const BadRequest = Schema.Struct({ status: Schema.Literal(400), body: RequestInvalid })

/** Just enough of an OpenAPI document to check what we serve. */
const OpenApiDocument = Schema.Struct({
  body: Schema.Struct({ openapi: Schema.String, paths: Schema.Record(Schema.String, Schema.Unknown) })
})

layer(ServerTest)("Sessions API", (it) => {
  it.effect("health", () =>
    Effect.gen(function*() {
      const client = yield* ApiClient
      strictEqual((yield* client.system.health()).status, "ok")
    }))

  it.effect("create → get → list → update → remove", () =>
    Effect.gen(function*() {
      const client = yield* ApiClient
      const created = yield* client.sessions.create({ payload: { title: "over the wire" } })
      const params = { id: created.id }

      assertEquals(yield* client.sessions.get({ params }), created)

      const listed = yield* client.sessions.list()
      assertTrue(listed.some((s) => s.id === created.id))

      const updated = yield* client.sessions.update({ params, payload: { title: "renamed" } })
      strictEqual(updated.title, "renamed")

      yield* client.sessions.remove({ params })
      assertFailure(yield* Effect.result(client.sessions.get({ params })), SessionNotFound.make(params))
    }))

  it.effect("unknown ids decode to a typed SessionNotFound", () =>
    Effect.gen(function*() {
      const client = yield* ApiClient
      const id = SessionId.make("00000000-0000-7000-8000-000000000000")
      assertFailure(yield* Effect.result(client.sessions.get({ params: { id } })), SessionNotFound.make({ id }))
    }))

  it.effect("invalid payloads are a 400 RequestInvalid with per-field issues", () =>
    Effect.gen(function*() {
      const http = yield* HttpClient.HttpClient
      const { body } = yield* http.execute(
        HttpClientRequest.post("/sessions").pipe(HttpClientRequest.bodyJsonUnsafe({ title: "" }))
      ).pipe(Effect.flatMap(HttpClientResponse.schemaJson(BadRequest)))
      strictEqual(body.location, "Payload")
      deepStrictEqual(body.issues.map((issue) => issue.path), [["title"]])
    }))

  it.effect("malformed JSON is a 400 RequestInvalid", () =>
    Effect.gen(function*() {
      const http = yield* HttpClient.HttpClient
      const { body } = yield* http.execute(
        HttpClientRequest.post("/sessions").pipe(HttpClientRequest.bodyText("not json", "application/json"))
      ).pipe(Effect.flatMap(HttpClientResponse.schemaJson(BadRequest)))
      strictEqual(body.location, "Payload")
    }))

  it.effect("ids that are not UUIDs are rejected at the edge", () =>
    Effect.gen(function*() {
      const http = yield* HttpClient.HttpClient
      const { body } = yield* http.get("/sessions/not-a-uuid").pipe(
        Effect.flatMap(HttpClientResponse.schemaJson(BadRequest))
      )
      strictEqual(body.location, "Params")
      deepStrictEqual(body.issues.map((issue) => issue.path), [["id"]])
    }))

  it.effect("serves the OpenAPI document", () =>
    Effect.gen(function*() {
      const http = yield* HttpClient.HttpClient
      const { body } = yield* http.get("/openapi.json").pipe(
        Effect.flatMap(HttpClientResponse.schemaJson(OpenApiDocument))
      )
      strictEqual(body.openapi, "3.1.0")
      for (const path of ["/health", "/sessions", "/sessions/{id}"]) {
        assertTrue(path in body.paths, `missing ${path}`)
      }
    }))
})

layer(ServerTest)("Sessions API when the database fails", (it) => {
  it.effect("infrastructure failures are a bare, typed 500", () =>
    Effect.gen(function*() {
      const client = yield* ApiClient
      const sql = yield* SqlClient.SqlClient
      yield* sql`DROP TABLE sessions`
      assertFailure(yield* Effect.result(client.sessions.list()), HttpApiError.InternalServerError.make({}))
    }))
})
