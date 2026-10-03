import { layer } from "@effect/vitest"
import { assertEquals, assertFailure, assertTrue, strictEqual } from "@effect/vitest/utils"
import { DateTime, Effect } from "effect"
import { TestClock } from "effect/testing"
import { SessionId, SessionNotFound } from "../src/domain/Session.ts"
import { Sessions } from "../src/services/Sessions.ts"
import { AppTest } from "./support/AppTest.ts"

const missing = SessionId.make("00000000-0000-7000-8000-000000000000")

layer(AppTest)("Sessions", (it) => {
  it.effect("create then get round-trips", () =>
    Effect.gen(function*() {
      const sessions = yield* Sessions
      const created = yield* sessions.create({ title: "first" })
      const fetched = yield* sessions.get(created.id)
      assertEquals(fetched, created)
      strictEqual(fetched.title, "first")
    }))

  it.effect("create stamps createdAt and updatedAt from the clock", () =>
    Effect.gen(function*() {
      const sessions = yield* Sessions
      yield* TestClock.setTime(Date.UTC(2026, 0, 1))
      const created = yield* sessions.create({ title: "clocked" })
      strictEqual(DateTime.formatIso(created.createdAt), "2026-01-01T00:00:00.000Z")
      assertEquals(created.updatedAt, created.createdAt)
    }))

  it.effect("list includes created sessions", () =>
    Effect.gen(function*() {
      const sessions = yield* Sessions
      const a = yield* sessions.create({ title: "list a" })
      const b = yield* sessions.create({ title: "list b" })
      const ids = new Set((yield* sessions.list).map((s) => s.id))
      assertTrue(ids.has(a.id))
      assertTrue(ids.has(b.id))
    }))

  it.effect("update changes the title and bumps updatedAt", () =>
    Effect.gen(function*() {
      const sessions = yield* Sessions
      const created = yield* sessions.create({ title: "before" })
      yield* TestClock.adjust("1 minute")
      const updated = yield* sessions.update(created.id, { title: "after" })
      strictEqual(updated.title, "after")
      assertEquals(updated.createdAt, created.createdAt)
      assertTrue(DateTime.isGreaterThan(updated.updatedAt, created.updatedAt))
    }))

  it.effect("remove deletes the session", () =>
    Effect.gen(function*() {
      const sessions = yield* Sessions
      const created = yield* sessions.create({ title: "doomed" })
      yield* sessions.remove(created.id)
      assertFailure(yield* Effect.result(sessions.get(created.id)), SessionNotFound.make({ id: created.id }))
    }))

  it.effect("missing sessions fail with SessionNotFound", () =>
    Effect.gen(function*() {
      const sessions = yield* Sessions
      const notFound = SessionNotFound.make({ id: missing })
      assertFailure(yield* Effect.result(sessions.get(missing)), notFound)
      assertFailure(yield* Effect.result(sessions.update(missing, { title: "x" })), notFound)
      assertFailure(yield* Effect.result(sessions.remove(missing)), notFound)
    }))
})
