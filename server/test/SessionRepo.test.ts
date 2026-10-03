import { layer } from "@effect/vitest"
import { assertFalse, assertNone, assertSome, assertTrue, strictEqual } from "@effect/vitest/utils"
import { Effect, Option } from "effect"
import { TestClock } from "effect/testing"
import { Session, SessionId } from "../src/domain/Session.ts"
import { SessionRepo } from "../src/services/SessionRepo.ts"
import { RepoTest } from "./support/AppTest.ts"

const missing = SessionId.make("00000000-0000-7000-8000-000000000000")

const insert = Effect.fn("test.insert")(function*(title: string) {
  const repo = yield* SessionRepo
  return yield* repo.insert(yield* Effect.orDie(Session.insert.makeEffect({ title })))
})

layer(RepoTest)("SessionRepo", (it) => {
  it.effect("findById returns None for unknown ids", () =>
    Effect.gen(function*() {
      const repo = yield* SessionRepo
      assertNone(yield* repo.findById(missing))
    }))

  it.effect("findById returns the decoded row", () =>
    Effect.gen(function*() {
      const repo = yield* SessionRepo
      const created = yield* insert("row")
      assertSome(yield* repo.findById(created.id), created)
    }))

  it.effect("findAll orders by most recently updated", () =>
    Effect.gen(function*() {
      const repo = yield* SessionRepo
      const older = yield* insert("older")
      yield* TestClock.adjust("1 second")
      const newer = yield* insert("newer")
      const ids = (yield* repo.findAll).map((s) => s.id)
      assertTrue(ids.indexOf(newer.id) < ids.indexOf(older.id))
    }))

  it.effect("update returns the updated row, or None when it does not exist", () =>
    Effect.gen(function*() {
      const repo = yield* SessionRepo
      const created = yield* insert("before")
      const updated = yield* repo.update(yield* Effect.orDie(Session.update.makeEffect({ id: created.id, title: "after" })))
      strictEqual(Option.getOrThrow(updated).title, "after")
      assertNone(yield* repo.update(yield* Effect.orDie(Session.update.makeEffect({ id: missing, title: "x" }))))
    }))

  it.effect("delete reports whether a row was removed", () =>
    Effect.gen(function*() {
      const repo = yield* SessionRepo
      const created = yield* insert("doomed")
      assertTrue(yield* repo.delete(created.id))
      assertFalse(yield* repo.delete(created.id))
    }))

  it.effect("database failures surface as a typed, classified SqlError", () =>
    Effect.gen(function*() {
      const repo = yield* SessionRepo
      const row = yield* Effect.orDie(Session.insert.makeEffect({ title: "twice" }))
      yield* repo.insert(row)
      const error = yield* Effect.flip(repo.insert(row))
      strictEqual(error._tag, "SqlError")
      // bun:sqlite classifies primary-key conflicts as ConstraintError (no extended codes)
      strictEqual(error.reason._tag, "ConstraintError")
      assertFalse(error.isRetryable)
    }))
})
