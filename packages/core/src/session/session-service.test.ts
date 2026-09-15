import { assert, layer } from "@effect/vitest"
import { ResumeSchema } from "@q/domain/session/model"
import { makeSessionId } from "@q/factories/session"
import { assertFailsWithTag } from "@q/test/assertions/exit"
import { CryptoLayerTest, DatabaseLayerTest } from "@q/test/db/layer"
import { Effect, Layer } from "effect"

import { SessionService } from "./session-service"

// Over the real repository on a throwaway database, built once for the block. Every test works in its
// own `cwd`, so the tests do not depend on their order. The clock is real: `created_at` orders sessions.

const Services = SessionService.live.pipe(Layer.provide([DatabaseLayerTest, CryptoLayerTest]))

layer(Services, { excludeTestServices: true })("SessionService", (it) => {
  it.effect("New starts a session; Latest resumes it per directory; Session finds it by id", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionService
      const fresh = yield* sessions.resolve(ResumeSchema.cases.New.make({}), "/resume/a")
      assert.strictEqual(fresh.cwd, "/resume/a")

      assert.deepStrictEqual(yield* sessions.resolve(ResumeSchema.cases.Latest.make({}), "/resume/a"), fresh)
      assert.deepStrictEqual(yield* sessions.resolve(ResumeSchema.cases.Session.make({ id: fresh.id }), "/resume/a"), fresh)
      assert.deepStrictEqual(yield* sessions.findById(fresh.id), fresh)

      // Latest in an empty directory creates one; a second call resumes it.
      const other = yield* sessions.resolve(ResumeSchema.cases.Latest.make({}), "/resume/b")
      assert.notStrictEqual(other.id, fresh.id)
      assert.deepStrictEqual(yield* sessions.resolve(ResumeSchema.cases.Latest.make({}), "/resume/b"), other)
    }),
  )

  it.effect("sessions belong to a directory, newest first", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionService
      const first = yield* sessions.resolve(ResumeSchema.cases.New.make({}), "/list/a")
      const second = yield* sessions.resolve(ResumeSchema.cases.New.make({}), "/list/a")
      yield* sessions.resolve(ResumeSchema.cases.New.make({}), "/list/b")

      assert.deepStrictEqual(
        (yield* sessions.list("/list/a")).map((s) => s.id),
        [second.id, first.id],
      )
      assert.deepStrictEqual(yield* sessions.list("/list/none"), [])
    }),
  )

  it.effect("an unknown id is SessionNotFoundError, from resolve and from findById", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionService
      const id = makeSessionId("nope")
      const resolved = yield* Effect.exit(sessions.resolve(ResumeSchema.cases.Session.make({ id }), "/missing"))
      assertFailsWithTag(resolved, "SessionNotFoundError")
      const found = yield* Effect.exit(sessions.findById(id))
      assertFailsWithTag(found, "SessionNotFoundError")
    }),
  )
})
