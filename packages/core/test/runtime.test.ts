import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Ref, type Scope, Semaphore, Stream } from "effect"
import { TestClock } from "effect/testing"

import { Program, Runtime } from "@q/kit"
import { settle, tick } from "@q/kit/testing"
import { Agent, AgentError, makeEchoAgent } from "../src/agent"
import { program } from "../src/program"
import { Message } from "../src/message"
import { type Model, Turn } from "../src/model"
import { coalesce } from "../src/subscription"
import { ConversationEvent, Outcome, Transcript, TranscriptError, makeInMemoryTranscript } from "../src/transcript"
import { init } from "../src/update"

type Services = Agent | Transcript | Scope.Scope | TestClock.TestClock

/** Run a scoped body with an echo agent and an in-memory transcript on a deterministic clock. */
const run = <A>(
  body: Effect.Effect<A, never, Services>,
  options: { agent?: Layer.Layer<Agent>; transcript?: Layer.Layer<Transcript> } = {},
) =>
  Effect.runPromise(
    body.pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          options.agent ?? makeEchoAgent("10 millis"),
          options.transcript ?? makeInMemoryTranscript(),
          TestClock.layer(),
        ),
      ),
    ),
  )

const assistantText = (runtime: Runtime.Runtime<Model, Message>) => runtime.model().messages[1]?.text

const loadTranscript = Effect.flatMap(Transcript, (transcript) => transcript.load).pipe(Effect.catch(Effect.die))

describe("program", () => {
  test("a prompt streams back in batches, ends the turn, and is written ahead to the transcript", () =>
    run(
      Effect.gen(function* () {
        const runtime = yield* Runtime.make(program)
        const log = yield* Effect.forkChild(
          Stream.runCollect(Stream.takeUntil(runtime.messages, (m) => m._tag === "SucceededCommitTurn")),
        )
        yield* Effect.yieldNow

        runtime.dispatch(Message.SubmittedPrompt({ text: "abcdef" }))
        expect(runtime.model().turn).toEqual(Turn.Accepting({ prompt: "abcdef" }))
        yield* settle
        expect(runtime.model().turn).toEqual(Turn.Streaming({ messageId: 1, prompt: "abcdef" }))
        expect(runtime.model().messages.map((m) => m.text)).toEqual(["abcdef", ""])

        yield* tick("33 millis")
        expect(assistantText(runtime)).toBe("abc")
        yield* tick("33 millis")
        expect(assistantText(runtime)).toBe("abcdef")
        expect(runtime.model().turn).toEqual(Turn.Idle())

        const messages = yield* Fiber.join(log)
        expect(messages.filter((m) => m._tag === "ReceivedText").length).toBeLessThanOrEqual(2)
        expect(messages.map((m) => m._tag)).toContain("CompletedTurn")

        expect(yield* loadTranscript).toEqual([
          ConversationEvent.PromptAccepted({ prompt: "abcdef" }),
          ConversationEvent.TurnEnded({ text: "abcdef", outcome: Outcome.Completed() }),
        ])
        expect(Program.replay(program.update, init({ events: [] }).model, messages)).toEqual(runtime.model())
      }),
    ))

  test("escape cancels the stream mid-turn and commits the partial text", () =>
    run(
      Effect.gen(function* () {
        const runtime = yield* Runtime.make(program)
        runtime.dispatch(Message.SubmittedPrompt({ text: "abcdef" }))
        yield* tick("33 millis")
        expect(assistantText(runtime)).toBe("abc")

        runtime.dispatch(Message.PressedEscape())
        expect(runtime.model().turn).toEqual(Turn.Idle())
        yield* tick("1 second")
        expect(assistantText(runtime)).toBe("abc")

        const transcript = yield* loadTranscript
        expect(transcript.at(-1)).toEqual(ConversationEvent.TurnEnded({ text: "abc", outcome: Outcome.Cancelled() }))
      }),
    ))

  test("a new prompt after cancellation starts a fresh stream", () =>
    run(
      Effect.gen(function* () {
        const runtime = yield* Runtime.make(program)
        runtime.dispatch(Message.SubmittedPrompt({ text: "ab" }))
        yield* settle
        runtime.dispatch(Message.PressedEscape())
        yield* settle
        runtime.dispatch(Message.SubmittedPrompt({ text: "xy" }))
        yield* tick("1 second")
        expect(runtime.model().messages.map((m) => m.text)).toEqual(["ab", "", "xy", "xy"])
        expect(runtime.model().turn).toEqual(Turn.Idle())
      }),
    ))

  test("an agent failure becomes a failed outcome in the transcript", () => {
    const failing = Layer.succeed(Agent, {
      stream: () => Stream.concat(Stream.make("o"), Stream.fail(new AgentError({ message: "offline" }))),
    })
    return run(
      Effect.gen(function* () {
        const runtime = yield* Runtime.make(program)
        runtime.dispatch(Message.SubmittedPrompt({ text: "hi" }))
        yield* tick("1 second")
        expect(assistantText(runtime)).toBe("o [error: offline]")
        expect(runtime.model().turn).toEqual(Turn.Idle())
        const transcript = yield* loadTranscript
        expect(transcript.at(-1)).toEqual(
          ConversationEvent.TurnEnded({ text: "o [error: offline]", outcome: Outcome.Failed({ error: "offline" }) }),
        )
      }),
      { agent: failing },
    )
  })

  test("a transcript that refuses writes keeps the model clean and shows a notice", () => {
    const readOnly = Layer.succeed(Transcript, {
      append: () => Effect.fail(new TranscriptError({ message: "read only" })),
      load: Effect.succeed([]),
    })
    return run(
      Effect.gen(function* () {
        const runtime = yield* Runtime.make(program)
        runtime.dispatch(Message.SubmittedPrompt({ text: "hi" }))
        yield* settle
        expect(runtime.model().messages).toEqual([])
        expect(runtime.model().turn).toEqual(Turn.Idle())
        expect(runtime.model().notice._tag).toBe("Some")
      }),
      { transcript: readOnly },
    )
  })

  test("the next prompt is accepted while the previous turn is still being recorded", () =>
    run(
      Effect.gen(function* () {
        // A transcript with latency: every append waits on a gate, and appends are serialised (the contract).
        const gate = yield* Ref.make(yield* Deferred.make<void>())
        const events = yield* Ref.make<ReadonlyArray<ConversationEvent>>([])
        const permit = yield* Semaphore.make(1)
        const gated = Layer.succeed(Transcript, {
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
        yield* open
        runtime.dispatch(Message.SubmittedPrompt({ text: "abcdef" }))
        yield* tick("33 millis")
        expect(runtime.model().turn).toEqual(Turn.Streaming({ messageId: 1, prompt: "abcdef" }))

        // Hold the transcript while turn one finishes: the turn ends at once, its record is in flight.
        yield* close
        yield* tick("1 second")
        expect(runtime.model().turn).toEqual(Turn.Idle())
        expect(assistantText(runtime)).toBe("abcdef")
        expect(yield* Ref.get(events)).toHaveLength(1)

        // Turn two is not refused: it is accepted behind the held record.
        runtime.dispatch(Message.SubmittedPrompt({ text: "xy" }))
        yield* settle
        expect(runtime.model().turn).toEqual(Turn.Accepting({ prompt: "xy" }))
        expect(runtime.model().messages).toHaveLength(2)

        yield* open
        yield* tick("1 second")
        expect(runtime.model().messages.map((m) => m.text)).toEqual(["abcdef", "abcdef", "xy", "xy"])
        expect(runtime.model().turn).toEqual(Turn.Idle())
        expect(yield* Ref.get(events)).toEqual([
          ConversationEvent.PromptAccepted({ prompt: "abcdef" }),
          ConversationEvent.TurnEnded({ text: "abcdef", outcome: Outcome.Completed() }),
          ConversationEvent.PromptAccepted({ prompt: "xy" }),
          ConversationEvent.TurnEnded({ text: "xy", outcome: Outcome.Completed() }),
        ])
      }),
    ))

  test("resume: a fresh program built from the transcript equals the live model", () =>
    run(
      Effect.gen(function* () {
        const live = yield* Runtime.make(program)
        live.dispatch(Message.SubmittedPrompt({ text: "abc" }))
        yield* tick("1 second")
        live.dispatch(Message.SubmittedPrompt({ text: "defg" }))
        yield* tick("33 millis")
        live.dispatch(Message.PressedEscape())
        yield* tick("1 second")
        expect(live.model().turn).toEqual(Turn.Idle())

        const restored = yield* Runtime.make(program)
        expect(restored.model()).toEqual(live.model())
        expect(restored.model().messages.map((m) => m.text)).toEqual(["abc", "abc", "defg", "def"])
      }),
    ))
})

describe("coalesce", () => {
  test("merges adjacent text for the same row and keeps terminal messages in order", () => {
    const batch = [
      Message.ReceivedText({ messageId: 1, text: "a" }),
      Message.ReceivedText({ messageId: 1, text: "b" }),
      Message.CompletedTurn({ messageId: 1 }),
    ]
    expect(coalesce(batch)).toEqual([
      Message.ReceivedText({ messageId: 1, text: "ab" }),
      Message.CompletedTurn({ messageId: 1 }),
    ])
    expect(coalesce([])).toEqual([])
  })
})
