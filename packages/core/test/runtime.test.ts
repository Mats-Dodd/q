import { assert, describe, it, layer } from "@effect/vitest"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Deferred, Effect, Fiber, Layer, Ref, Semaphore, Stream } from "effect"
import { TestClock } from "effect/testing"

import { Program, Runtime } from "@q/kit"
import { ConversationEvent, Outcome } from "../src/domain/event"
import { type Model, Turn } from "../src/domain/model"
import { Message } from "../src/message"
import { program } from "../src/program"
import { Agent, AgentError } from "../src/services/agent"
import { TranscriptRepository } from "../src/services/repository"
import { Resume, Transcript, TranscriptError } from "../src/services/transcript"
import { coalesce } from "../src/subscription"
import { init } from "../src/update"

// Shared by the block: the echo agent and the repository on a throwaway database. Per test: a new
// session, provided inside the body. `it.effect` runs on a TestClock, so time is `TestClock.adjust`
// and completion is a message on `runtime.messages`, waited for before the dispatch that causes it.
//
// Rule: wait for `SucceededAcceptPrompt` before adjusting the clock. The agent stream starts after
// the transcript accepts the prompt (write-ahead); time advanced before that fires no sleeps.

const Shared = Layer.mergeAll(
  Agent.Echo("10 millis"),
  TranscriptRepository.Sql.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" }))),
)

const session = Transcript.Session(Resume.cases.New.make({}), "/test")

const assistantText = (runtime: Runtime.Runtime<Model, Message>) => runtime.model().messages[1]?.text

const loadTranscript = Effect.flatMap(Transcript, (transcript) => transcript.load).pipe(Effect.catch(Effect.die))

/** Fork a wait for the first Message that satisfies `predicate`. Fork before the dispatch, join after. */
const awaiting = (runtime: Runtime.Runtime<Model, Message>, predicate: (message: Message) => boolean) =>
  Effect.forkChild(Stream.runHead(Stream.filter(runtime.messages, predicate)), { startImmediately: true })

const accepted = (m: Message) => m._tag === "SucceededAcceptPrompt"
const received = (m: Message) => m._tag === "ReceivedText"
const committed = (messageId: number) => (m: Message) => m._tag === "SucceededCommitTurn" && m.messageId === messageId

layer(Shared)("program", (it) => {
  it.effect("a prompt streams back in batches, ends the turn, and is written ahead to the transcript", () =>
    Effect.gen(function* () {
      const runtime = yield* Runtime.make(program)
      const log = yield* Effect.forkChild(Stream.runCollect(Stream.takeUntil(runtime.messages, committed(1))), {
        startImmediately: true,
      })
      const accept = yield* awaiting(runtime, accepted)
      const abc = yield* awaiting(runtime, received)

      runtime.dispatch(Message.cases.SubmittedPrompt.make({ text: "abcdef" }))
      assert.deepStrictEqual(runtime.model().turn, Turn.cases.Accepting.make({ prompt: "abcdef" }))
      yield* Fiber.join(accept)
      assert.deepStrictEqual(runtime.model().turn, Turn.cases.Streaming.make({ messageId: 1, prompt: "abcdef" }))
      assert.deepStrictEqual(runtime.model().messages.map((m) => m.text), ["abcdef", ""])

      yield* TestClock.adjust("33 millis")
      yield* Fiber.join(abc)
      assert.strictEqual(assistantText(runtime), "abc")
      yield* TestClock.adjust("33 millis")
      const messages = yield* Fiber.join(log)
      assert.strictEqual(assistantText(runtime), "abcdef")
      assert.deepStrictEqual(runtime.model().turn, Turn.cases.Idle.make({}))

      assert.isTrue(messages.filter(received).length <= 2)
      assert.include(messages.map((m) => m._tag), "CompletedTurn")
      assert.deepStrictEqual(yield* loadTranscript, [
        ConversationEvent.cases.PromptAccepted.make({ prompt: "abcdef" }),
        ConversationEvent.cases.TurnEnded.make({ text: "abcdef", outcome: Outcome.cases.Completed.make({}) }),
      ])
      assert.deepStrictEqual(Program.replay(program.update, init({ events: [] }).model, messages), runtime.model())
    }).pipe(Effect.provide(session)),
  )

  it.effect("escape cancels the stream mid-turn and commits the partial text", () =>
    Effect.gen(function* () {
      const runtime = yield* Runtime.make(program)
      const accept = yield* awaiting(runtime, accepted)
      const abc = yield* awaiting(runtime, received)
      const commit = yield* awaiting(runtime, committed(1))

      runtime.dispatch(Message.cases.SubmittedPrompt.make({ text: "abcdef" }))
      yield* Fiber.join(accept)
      yield* TestClock.adjust("33 millis")
      yield* Fiber.join(abc)
      assert.strictEqual(assistantText(runtime), "abc")

      runtime.dispatch(Message.cases.PressedEscape.make({}))
      assert.deepStrictEqual(runtime.model().turn, Turn.cases.Idle.make({}))
      yield* Fiber.join(commit)
      yield* TestClock.adjust("1 second")
      assert.strictEqual(assistantText(runtime), "abc")

      const transcript = yield* loadTranscript
      assert.deepStrictEqual(transcript.at(-1), ConversationEvent.cases.TurnEnded.make({ text: "abc", outcome: Outcome.cases.Cancelled.make({}) }))
    }).pipe(Effect.provide(session)),
  )

  it.effect("a new prompt after cancellation starts a fresh stream", () =>
    Effect.gen(function* () {
      const runtime = yield* Runtime.make(program)
      const accept = yield* awaiting(runtime, accepted)
      const second = yield* awaiting(runtime, committed(3))

      runtime.dispatch(Message.cases.SubmittedPrompt.make({ text: "ab" }))
      yield* Fiber.join(accept)
      runtime.dispatch(Message.cases.PressedEscape.make({}))
      runtime.dispatch(Message.cases.SubmittedPrompt.make({ text: "xy" }))
      yield* TestClock.adjust("1 second")
      yield* Fiber.join(second)
      assert.deepStrictEqual(runtime.model().messages.map((m) => m.text), ["ab", "", "xy", "xy"])
      assert.deepStrictEqual(runtime.model().turn, Turn.cases.Idle.make({}))
    }).pipe(Effect.provide(session)),
  )

  it.effect("an agent failure becomes a failed outcome in the transcript", () =>
    Effect.gen(function* () {
      const failing = Layer.succeed(Agent)({
        stream: () => Stream.concat(Stream.make("o"), Stream.fail(new AgentError({ message: "offline" }))),
      })
      const runtime = yield* Runtime.make(program).pipe(Effect.provide(failing))
      const commit = yield* awaiting(runtime, committed(1))

      runtime.dispatch(Message.cases.SubmittedPrompt.make({ text: "hi" }))
      yield* TestClock.adjust("1 second")
      yield* Fiber.join(commit)
      assert.strictEqual(assistantText(runtime), "o [error: offline]")
      assert.deepStrictEqual(runtime.model().turn, Turn.cases.Idle.make({}))
      const transcript = yield* loadTranscript
      assert.deepStrictEqual(
        transcript.at(-1),
        ConversationEvent.cases.TurnEnded.make({ text: "o [error: offline]", outcome: Outcome.cases.Failed.make({ error: "offline" }) }),
      )
    }).pipe(Effect.provide(session)),
  )

  it.effect("a transcript that refuses writes keeps the model clean and shows a notice", () =>
    Effect.gen(function* () {
      const readOnly = Layer.succeed(Transcript)({
        append: () => Effect.fail(new TranscriptError({ cause: new Error("read only") })),
        load: Effect.succeed([]),
      })
      const runtime = yield* Runtime.make(program).pipe(Effect.provide(readOnly))
      const refused = yield* awaiting(runtime, (m) => m._tag === "FailedAcceptPrompt")

      runtime.dispatch(Message.cases.SubmittedPrompt.make({ text: "hi" }))
      yield* Fiber.join(refused)
      assert.deepStrictEqual(runtime.model().messages, [])
      assert.deepStrictEqual(runtime.model().turn, Turn.cases.Idle.make({}))
      assert.strictEqual(runtime.model().notice._tag, "Some")
    }),
  )

  it.effect("the next prompt is accepted while the previous turn is still being recorded", () =>
    Effect.gen(function* () {
      // A transcript with latency: every append waits on a gate, and appends are serialised (the contract).
      const gate = yield* Ref.make(yield* Deferred.make<void>())
      const events = yield* Ref.make<ReadonlyArray<ConversationEvent>>([])
      const permit = yield* Semaphore.make(1)
      const gated = Layer.succeed(Transcript)({
        append: (event) =>
          permit.withPermits(1)(
            Effect.andThen(
              Effect.flatMap(Ref.get(gate), Deferred.await),
              Ref.update(events, (all) => [...all, event]),
            ),
          ),
        load: Ref.get(events),
      })
      const open = Effect.flatMap(Ref.get(gate), (d) => Deferred.succeed(d, undefined))
      const close = Effect.flatMap(Deferred.make<void>(), (d) => Ref.set(gate, d))

      const runtime = yield* Runtime.make(program).pipe(Effect.provide(gated))
      const accept = yield* awaiting(runtime, accepted)
      const abc = yield* awaiting(runtime, received)
      const ended = yield* awaiting(runtime, (m) => m._tag === "CompletedTurn" && m.messageId === 1)
      const second = yield* awaiting(runtime, committed(3))

      yield* open
      runtime.dispatch(Message.cases.SubmittedPrompt.make({ text: "abcdef" }))
      yield* Fiber.join(accept)
      yield* TestClock.adjust("33 millis")
      yield* Fiber.join(abc)
      assert.deepStrictEqual(runtime.model().turn, Turn.cases.Streaming.make({ messageId: 1, prompt: "abcdef" }))

      // Hold the transcript while turn one finishes: the turn ends at once, its record is in flight.
      yield* close
      yield* TestClock.adjust("1 second")
      yield* Fiber.join(ended)
      assert.deepStrictEqual(runtime.model().turn, Turn.cases.Idle.make({}))
      assert.strictEqual(assistantText(runtime), "abcdef")
      assert.strictEqual((yield* Ref.get(events)).length, 1)

      // Turn two is not refused: it is accepted behind the held record.
      runtime.dispatch(Message.cases.SubmittedPrompt.make({ text: "xy" }))
      yield* TestClock.adjust("1 second")
      assert.deepStrictEqual(runtime.model().turn, Turn.cases.Accepting.make({ prompt: "xy" }))
      assert.strictEqual(runtime.model().messages.length, 2)

      yield* open
      yield* TestClock.adjust("1 second")
      yield* Fiber.join(second)
      assert.deepStrictEqual(runtime.model().messages.map((m) => m.text), ["abcdef", "abcdef", "xy", "xy"])
      assert.deepStrictEqual(runtime.model().turn, Turn.cases.Idle.make({}))
      assert.deepStrictEqual(yield* Ref.get(events), [
        ConversationEvent.cases.PromptAccepted.make({ prompt: "abcdef" }),
        ConversationEvent.cases.TurnEnded.make({ text: "abcdef", outcome: Outcome.cases.Completed.make({}) }),
        ConversationEvent.cases.PromptAccepted.make({ prompt: "xy" }),
        ConversationEvent.cases.TurnEnded.make({ text: "xy", outcome: Outcome.cases.Completed.make({}) }),
      ])
    }),
  )

  it.effect("resume: a fresh program built from the transcript equals the live model", () =>
    Effect.gen(function* () {
      const live = yield* Runtime.make(program)
      const acceptFirst = yield* awaiting(live, accepted)
      const first = yield* awaiting(live, committed(1))
      const second = yield* awaiting(live, committed(3))

      live.dispatch(Message.cases.SubmittedPrompt.make({ text: "abc" }))
      yield* Fiber.join(acceptFirst)
      yield* TestClock.adjust("1 second")
      yield* Fiber.join(first)

      const acceptSecond = yield* awaiting(live, accepted)
      const def = yield* awaiting(live, (m) => received(m) && m.messageId === 3)
      live.dispatch(Message.cases.SubmittedPrompt.make({ text: "defg" }))
      yield* Fiber.join(acceptSecond)
      yield* TestClock.adjust("33 millis")
      yield* Fiber.join(def)
      live.dispatch(Message.cases.PressedEscape.make({}))
      yield* Fiber.join(second)
      assert.deepStrictEqual(live.model().turn, Turn.cases.Idle.make({}))

      const restored = yield* Runtime.make(program)
      assert.deepStrictEqual(restored.model(), live.model())
      assert.deepStrictEqual(restored.model().messages.map((m) => m.text), ["abc", "abc", "defg", "def"])
    }).pipe(Effect.provide(session)),
  )
})

describe("coalesce", () => {
  it("merges adjacent text for the same row and keeps terminal messages in order", () => {
    const batch = [
      Message.cases.ReceivedText.make({ messageId: 1, text: "a" }),
      Message.cases.ReceivedText.make({ messageId: 1, text: "b" }),
      Message.cases.CompletedTurn.make({ messageId: 1 }),
    ]
    assert.deepStrictEqual(coalesce(batch), [
      Message.cases.ReceivedText.make({ messageId: 1, text: "ab" }),
      Message.cases.CompletedTurn.make({ messageId: 1 }),
    ])
    assert.deepStrictEqual(coalesce([]), [])
  })
})
