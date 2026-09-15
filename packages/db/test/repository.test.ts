import { assert, it, layer } from "@effect/vitest"
import { BunFileSystem } from "@effect/platform-bun"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Cause, Context, Deferred, Effect, Fiber, FileSystem, Layer, Ref } from "effect"
import { SqlClient } from "effect/unstable/sql"

import { ConversationEvent, Outcome, Resume, SessionId, Transcript, TranscriptRepository } from "@q/core"
import { Sql } from "../src"

// End to end over the real SQLite Layer. One throwaway database per block, built once; every test
// works in its own `cwd`, so the tests do not depend on their order. The clock is real: `created_at`
// orders sessions.

const Sqlite = Sql.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))

/** The `Transcript` of one session, built in the test's Scope over the block's repository. */
const transcript = (resume: Resume, cwd: string) =>
  Effect.map(Layer.build(Transcript.Session(resume, cwd)), (context) => Context.get(context, Transcript))

const prompt = ConversationEvent.cases.PromptAccepted.make({ prompt: "hi" })
const ended = ConversationEvent.cases.TurnEnded.make({ text: "hi", outcome: Outcome.cases.Failed.make({ error: "boom" }) })

layer(Sqlite, { excludeTestServices: true })("Transcript.Session", (it) => {
  it.effect("New starts empty; Latest resumes it per directory; Session by id; an unknown id fails the Layer", () =>
    Effect.gen(function* () {
      const fresh = yield* transcript(Resume.cases.New.make({}), "/resume/a")
      assert.deepStrictEqual(yield* fresh.load, [])
      yield* fresh.append(prompt)
      yield* fresh.append(ended)

      assert.deepStrictEqual(yield* (yield* transcript(Resume.cases.Latest.make({}), "/resume/a")).load, [prompt, ended])
      assert.deepStrictEqual(yield* (yield* transcript(Resume.cases.Latest.make({}), "/resume/b")).load, [])

      const [session] = yield* (yield* TranscriptRepository).sessions("/resume/a")
      assert.deepStrictEqual(yield* (yield* transcript(Resume.cases.Session.make({ id: session!.id }), "/resume/a")).load, [prompt, ended])

      const missing = yield* Effect.flip(transcript(Resume.cases.Session.make({ id: SessionId.make("nope") }), "/resume/a"))
      assert.strictEqual(missing._tag, "TranscriptError")
      assert.include(missing.message, "no session nope")
    }),
  )

  it.effect("appends in flight together land in issue order", () =>
    Effect.gen(function* () {
      const repository = yield* TranscriptRepository
      const session = yield* repository.createSession("/order")
      const gate = yield* Deferred.make<void>()
      const order = yield* Ref.make<ReadonlyArray<string>>([])
      // The real repository with latency on the first append only: the second must still land behind it.
      const slow = Layer.succeed(TranscriptRepository)({
        ...repository,
        append: (id, event) =>
          Effect.gen(function* () {
            if (event._tag === "PromptAccepted") yield* Deferred.await(gate)
            yield* Ref.update(order, (all) => [...all, event._tag])
            yield* repository.append(id, event)
          }),
      })
      const bound = yield* transcript(Resume.cases.Session.make({ id: session.id }), "/order").pipe(Effect.provide(slow))

      const a = yield* Effect.forkChild(bound.append(prompt))
      const b = yield* Effect.forkChild(bound.append(ended))
      yield* Effect.yieldNow
      assert.deepStrictEqual(yield* Ref.get(order), [])
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(a)
      yield* Fiber.join(b)

      assert.deepStrictEqual(yield* Ref.get(order), ["PromptAccepted", "TurnEnded"])
      assert.deepStrictEqual(yield* repository.events(session.id), [prompt, ended])
    }),
  )
})

layer(Sqlite, { excludeTestServices: true })("Sql", (it) => {
  it.effect("sessions belong to a directory, newest first; a missing session is NoSuchElementError", () =>
    Effect.gen(function* () {
      const repository = yield* TranscriptRepository
      const first = yield* repository.createSession("/sessions/a")
      const second = yield* repository.createSession("/sessions/a")
      yield* repository.createSession("/sessions/b")

      assert.deepStrictEqual((yield* repository.sessions("/sessions/a")).map((s) => s.id), [second.id, first.id])
      assert.deepStrictEqual(yield* repository.sessions("/sessions/none"), [])
      assert.deepStrictEqual(yield* repository.findSession(first.id), first)
      assert.isTrue(Cause.isNoSuchElementError(yield* Effect.flip(repository.findSession(SessionId.make("nope")))))
    }),
  )

  it.effect("a row that is not a ConversationEvent is a TranscriptError, not a value", () =>
    Effect.gen(function* () {
      const repository = yield* TranscriptRepository
      const sql = yield* SqlClient.SqlClient
      const session = yield* repository.createSession("/bogus")
      yield* repository.append(session.id, prompt)
      yield* sql`INSERT INTO events (session_id, kind, body, created_at) VALUES (${session.id}, ${"Bogus"}, ${'{"_tag":"Bogus"}'}, ${0})`

      const error = yield* Effect.flip(repository.events(session.id))
      assert.strictEqual(error._tag, "TranscriptError")
      assert.include(error.message, "SchemaError")
    }),
  )
})

it.live("two clients on one file see each other's sessions; migrations run once", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped()
    const client = () => Sql.pipe(Layer.provideMerge(SqliteClient.layer({ filename: `${directory}/q.db` })))

    const a = yield* Layer.build(client())
    const b = yield* Layer.build(client())
    const [repoA, repoB] = [Context.get(a, TranscriptRepository), Context.get(b, TranscriptRepository)]
    const session = yield* repoA.createSession("/shared")
    yield* repoA.append(session.id, prompt)
    yield* repoB.append(session.id, ended)
    assert.deepStrictEqual(yield* repoA.events(session.id), [prompt, ended])
    assert.deepStrictEqual(yield* repoB.sessions("/shared"), [session])

    const sql = Context.get(b, SqlClient.SqlClient)
    assert.deepStrictEqual(yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM q_migrations`, [{ n: 1 }])
  }).pipe(Effect.provide(BunFileSystem.layer)),
)
