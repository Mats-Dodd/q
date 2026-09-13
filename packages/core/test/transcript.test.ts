import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Context, Deferred, Effect, Fiber, Layer, Ref } from "effect"
import { SqlClient } from "effect/unstable/sql"

import { ConversationEvent, Outcome } from "../src/domain/event"
import { SessionId } from "../src/domain/session"
import { SqlTranscriptRepository, TranscriptRepository } from "../src/services/repository"
import { Resume, SessionTranscript, Transcript } from "../src/services/transcript"

// End to end over the real SQLite Layer on a throwaway database. Substitutes are plain `Layer.succeed`.

const Sqlite = SqlTranscriptRepository.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))

const transcript = (resume: Resume, cwd = "/a") =>
  Effect.map(Layer.build(SessionTranscript(resume, cwd)), (context) => Context.get(context, Transcript))

const prompt = ConversationEvent.PromptAccepted({ prompt: "hi" })
const ended = ConversationEvent.TurnEnded({ text: "hi", outcome: Outcome.Failed({ error: "boom" }) })

describe("SessionTranscript", () => {
  test("New starts empty; Latest resumes it per directory; Session by id; an unknown id fails the Layer", () =>
    Effect.gen(function* () {
      const fresh = yield* transcript(Resume.New())
      expect(yield* fresh.load).toEqual([])
      yield* fresh.append(prompt)
      yield* fresh.append(ended)

      expect(yield* (yield* transcript(Resume.Latest())).load).toEqual([prompt, ended])
      expect(yield* (yield* transcript(Resume.Latest(), "/b")).load).toEqual([])

      const [session] = yield* (yield* TranscriptRepository).sessions("/a")
      expect(yield* (yield* transcript(Resume.Session({ id: session!.id }))).load).toEqual([prompt, ended])

      const missing = yield* Effect.flip(transcript(Resume.Session({ id: SessionId.make("nope") })))
      expect(missing._tag).toBe("TranscriptError")
      expect(missing.message).toContain("no session nope")
    }).pipe(Effect.scoped, Effect.provide(Sqlite), Effect.runPromise))

  test("appends in flight together land in issue order", () =>
    Effect.gen(function* () {
      const repository = yield* TranscriptRepository
      const session = yield* repository.createSession("/a")
      const gate = yield* Deferred.make<void>()
      const order = yield* Ref.make<ReadonlyArray<string>>([])
      // The real repository with latency on the first append only: the second must still land behind it.
      const slow = Layer.succeed(TranscriptRepository, {
        ...repository,
        append: (id, event) =>
          Effect.gen(function* () {
            if (event._tag === "PromptAccepted") yield* Deferred.await(gate)
            yield* Ref.update(order, (all) => [...all, event._tag])
            yield* repository.append(id, event)
          }),
      })
      const bound = yield* transcript(Resume.Session({ id: session.id })).pipe(Effect.provide(slow))

      const a = yield* Effect.forkChild(bound.append(prompt))
      const b = yield* Effect.forkChild(bound.append(ended))
      yield* Effect.yieldNow
      expect(yield* Ref.get(order)).toEqual([])
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(a)
      yield* Fiber.join(b)

      expect(yield* Ref.get(order)).toEqual(["PromptAccepted", "TurnEnded"])
      expect(yield* repository.events(session.id)).toEqual([prompt, ended])
    }).pipe(Effect.scoped, Effect.provide(Sqlite), Effect.runPromise))
})

describe("SqlTranscriptRepository", () => {
  test("sessions belong to a directory, newest first; a missing session is NoSuchElementError", () =>
    Effect.gen(function* () {
      const repository = yield* TranscriptRepository
      const first = yield* repository.createSession("/a")
      const second = yield* repository.createSession("/a")
      yield* repository.createSession("/b")

      expect((yield* repository.sessions("/a")).map((s) => s.id)).toEqual([second.id, first.id])
      expect(yield* repository.sessions("/none")).toEqual([])
      expect(yield* repository.findSession(first.id)).toEqual(first)
      expect((yield* Effect.flip(repository.findSession(SessionId.make("nope"))))._tag).toBe("NoSuchElementError")
    }).pipe(Effect.scoped, Effect.provide(Sqlite), Effect.runPromise))

  test("a row that is not a ConversationEvent is a TranscriptError, not a value", () =>
    Effect.gen(function* () {
      const repository = yield* TranscriptRepository
      const sql = yield* SqlClient.SqlClient
      const session = yield* repository.createSession("/a")
      yield* repository.append(session.id, prompt)
      yield* sql`INSERT INTO events (session_id, kind, body, created_at) VALUES (${session.id}, ${"Bogus"}, ${'{"_tag":"Bogus"}'}, ${0})`

      const error = yield* Effect.flip(repository.events(session.id))
      expect(error._tag).toBe("TranscriptError")
      expect(error.message).toContain("SchemaError")
    }).pipe(Effect.scoped, Effect.provide(Sqlite), Effect.runPromise))

  test("two clients on one file see each other's sessions; migrations run once", async () => {
    const filename = `/tmp/q-transcript-${crypto.randomUUID()}.db`
    const client = () => SqlTranscriptRepository.pipe(Layer.provideMerge(SqliteClient.layer({ filename })))
    try {
      await Effect.gen(function* () {
        const a = yield* Layer.build(client())
        const b = yield* Layer.build(client())
        const [repoA, repoB] = [Context.get(a, TranscriptRepository), Context.get(b, TranscriptRepository)]
        const session = yield* repoA.createSession("/shared")
        yield* repoA.append(session.id, prompt)
        yield* repoB.append(session.id, ended)
        expect(yield* repoA.events(session.id)).toEqual([prompt, ended])
        expect(yield* repoB.sessions("/shared")).toEqual([session])

        const sql = Context.get(b, SqlClient.SqlClient)
        expect(yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM q_migrations`).toEqual([{ n: 1 }])
      }).pipe(Effect.scoped, Effect.runPromise)
    } finally {
      const { rm } = await import("node:fs/promises")
      await Promise.all([filename, `${filename}-wal`, `${filename}-shm`].map((f) => rm(f, { force: true })))
    }
  })
})
