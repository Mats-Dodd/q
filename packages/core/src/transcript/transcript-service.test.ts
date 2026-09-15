import { assert, layer } from "@effect/vitest"
import { ResumeSchema } from "@q/domain/session/model"
import { OutcomeSchema } from "@q/domain/transcript/model"
import { makePromptAccepted, makeTurnEnded } from "@q/factories/conversation-event"
import { assertDies } from "@q/test/assertions/exit"
import { CryptoLayerTest, DatabaseLayerTest } from "@q/test/db/layer"
import { Deferred, Effect, Fiber, Layer, Ref } from "effect"
import { SqlClient } from "effect/unstable/sql"

import { SessionService } from "../session/session-service"
import { TranscriptRepository } from "./transcript-repository"
import { TranscriptService } from "./transcript-service"

// Over the real repository on a throwaway database. Sessions come from the session module: the
// transcript module never writes the `session` table.

const Services = Layer.mergeAll(TranscriptService.live, SessionService.live).pipe(
  Layer.provideMerge(DatabaseLayerTest),
  Layer.provide(CryptoLayerTest),
)

const newSession = (cwd: string) => Effect.flatMap(SessionService, (sessions) => sessions.resolve(ResumeSchema.cases.New.make({}), cwd))

const prompt = makePromptAccepted("hi")
const ended = makeTurnEnded("hi", OutcomeSchema.cases.Failed.make({ error: "boom" }))

layer(Services, { excludeTestServices: true })("TranscriptService", (it) => {
  it.effect("a new session is empty; appends come back in order, per session", () =>
    Effect.gen(function* () {
      const transcript = yield* TranscriptService
      const a = yield* newSession("/order/a")
      const b = yield* newSession("/order/b")
      assert.deepStrictEqual(yield* transcript.load(a.id), [])

      yield* transcript.append(a.id, prompt)
      yield* transcript.append(b.id, ended)
      yield* transcript.append(a.id, ended)
      assert.deepStrictEqual(yield* transcript.load(a.id), [prompt, ended])
      assert.deepStrictEqual(yield* transcript.load(b.id), [ended])
    }),
  )

  it.effect("appends in flight together land in issue order", () =>
    Effect.gen(function* () {
      const repository = yield* Effect.provide(TranscriptRepository, TranscriptRepository.layer)
      const session = yield* newSession("/inflight")
      const gate = yield* Deferred.make<void>()
      const order = yield* Ref.make<ReadonlyArray<string>>([])
      // The real repository with latency on the first append only: the second must still land behind it.
      const slow = Layer.succeed(
        TranscriptRepository,
        TranscriptRepository.of({
          ...repository,
          insert: (id, event) =>
            Effect.gen(function* () {
              if (event._tag === "PromptAccepted") yield* Deferred.await(gate)
              yield* Ref.update(order, (all) => [...all, event._tag])
              yield* repository.insert(id, event)
            }),
        }),
      )
      // `fresh`: the block already built `TranscriptService.layer` over the real repository; this one must not reuse it.
      const transcript = yield* Effect.provide(TranscriptService, Layer.fresh(TranscriptService.layer).pipe(Layer.provide(slow)))

      const a = yield* Effect.forkChild(transcript.append(session.id, prompt))
      const b = yield* Effect.forkChild(transcript.append(session.id, ended))
      yield* Effect.yieldNow
      assert.deepStrictEqual(yield* Ref.get(order), [])
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(a)
      yield* Fiber.join(b)

      assert.deepStrictEqual(yield* Ref.get(order), ["PromptAccepted", "TurnEnded"])
      assert.deepStrictEqual(yield* repository.findBySessionId(session.id), [prompt, ended])
    }),
  )

  it.effect("a row that is not a ConversationEvent is a defect, not a value", () =>
    Effect.gen(function* () {
      const transcript = yield* TranscriptService
      const sql = yield* SqlClient.SqlClient
      const session = yield* newSession("/bogus")
      yield* transcript.append(session.id, prompt)
      yield* sql`INSERT INTO transcript_event (session_id, kind, body, created_at) VALUES (${session.id}, ${"Bogus"}, ${'{"_tag":"Bogus"}'}, ${0})`

      assertDies(yield* Effect.exit(transcript.load(session.id)))
    }),
  )
})
