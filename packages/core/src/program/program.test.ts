import { assert, describe, it, layer } from "@effect/vitest"
import { TurnSchema } from "@q/domain/conversation/model"
import type { ChatChunk, ChatMessage, ChatMessagePart, ConversationModel } from "@q/domain/conversation/model"
import { PersistenceError } from "@q/domain/persistence-error"
import { ResumeSchema } from "@q/domain/session/model"
import { ConversationEventSchema, OutcomeSchema } from "@q/domain/transcript/model"
import type { ConversationEvent } from "@q/domain/transcript/model"
import { makeBashApprovalChunks, makeBashOutputChunk, makeReadCallChunks, makeTextChunks } from "@q/factories/chat-chunk"
import { textOf } from "@q/factories/conversation-model"
import { makeSession } from "@q/factories/session"
import * as Runtime from "@q/kit/runtime"
import { CryptoLayerTest, DatabaseLayerTest } from "@q/test/db/layer"
import { advancingUntil, awaiting, providing } from "@q/test/runtime"
import { Context, Deferred, Effect, Fiber, Layer, Option, Ref, Semaphore, Stream } from "effect"
import { TestClock } from "effect/testing"
import { isToolUIPart } from "effect-ai-ui/UIMessage"

import { AgentError, AgentService } from "@q/core/agent/agent-service"
import { CurrentSession } from "@q/core/session/current-session"
import { SessionService } from "@q/core/session/session-service"
import { TranscriptService } from "@q/core/transcript/transcript-service"
import { MessageSchema } from "./message"
import type { Message } from "./message"
import { program } from "./program"
import { coalesce } from "./subscription"
import { init } from "./update"

// Shared by the block: the echo agent and the real services on a throwaway SQLite database. Per test: a
// new session, provided inside the body. `it.effect` runs on a TestClock, so time is `TestClock.adjust`
// and completion is a message on `runtime.messages`, waited for before the dispatch that causes it.
//
// Rule: wait for `SucceededAcceptPrompt` before adjusting the clock. The agent stream starts after
// the transcript accepts the prompt (write-ahead); time advanced before that fires no sleeps.

const Shared = Layer.mergeAll(AgentService.layerEcho("10 millis"), TranscriptService.live, SessionService.live).pipe(
  Layer.provideMerge(DatabaseLayerTest),
  Layer.provide(CryptoLayerTest),
)

/** A new session for this test, as `CurrentSession`. */
const withNewSession = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const sessions = yield* SessionService
    const session = yield* sessions.resolve(ResumeSchema.cases.New.make({}), "/test")
    return yield* Effect.provideService(self, CurrentSession, session)
  })

const texts = (runtime: Runtime.Runtime<ConversationModel, Message>) => runtime.model().messages.map(textOf)
const assistantText = (runtime: Runtime.Runtime<ConversationModel, Message>) => textOf(runtime.model().messages[1])

/** What the echo agent leaves behind for `text`. */
const echoParts = (text: string): ReadonlyArray<ChatMessagePart> => [
  { type: "step-start" },
  { type: "text", id: "echo", text, state: "done" },
]

const loadTranscript = Effect.gen(function* () {
  const { id } = yield* CurrentSession
  const transcript = yield* TranscriptService
  return yield* transcript.load(id)
}).pipe(Effect.orDie)

const accepted = (m: Message) => m._tag === "SucceededAcceptPrompt"
const received = (m: Message) => m._tag === "ReceivedChunk" && m.chunk.type === "text-delta"
const finished = (messageId: string) => (m: Message) =>
  m._tag === "ReceivedChunk" && m.chunk.type === "finish-step" && m.messageId === messageId
const committed = (messageId: string) => (m: Message) => m._tag === "SucceededCommitTurn" && m.messageId === messageId

layer(Shared)("program", (it) => {
  it.effect("a prompt streams back as it arrives, ends the turn, and is written ahead to the transcript", () =>
    Effect.gen(function* () {
      const runtime = yield* Runtime.make(program)
      const log = yield* Effect.forkChild(Stream.runCollect(Stream.takeUntil(runtime.messages, committed("1"))), {
        startImmediately: true,
      })
      const accept = yield* awaiting(runtime, accepted)
      const abc = yield* awaiting(runtime, received)

      runtime.dispatch(MessageSchema.cases.SubmittedPrompt.make({ text: "abcdef" }))
      assert.deepStrictEqual(runtime.model().turn, TurnSchema.cases.Accepting.make({ prompt: "abcdef" }))
      yield* Fiber.join(accept)
      assert.deepStrictEqual(runtime.model().turn, TurnSchema.cases.Streaming.make({ messageId: "1", round: 0 }))
      assert.deepStrictEqual(texts(runtime), ["abcdef", ""])

      // Text is on the Model before the step is over.
      yield* advancingUntil(abc)
      const partial = assistantText(runtime)
      assert.isTrue(partial.length > 0 && partial.length < 6 && "abcdef".startsWith(partial))
      const messages = yield* advancingUntil(log)
      assert.strictEqual(assistantText(runtime), "abcdef")
      assert.deepStrictEqual(runtime.model().turn, TurnSchema.cases.Idle.make({}))

      // The echo agent paces one character at a time; each one was a message of its own. Nothing waited.
      assert.strictEqual(messages.filter(received).length, 6)
      assert.isTrue(messages.some(finished("1")))
      assert.deepStrictEqual(yield* loadTranscript, [
        ConversationEventSchema.cases.PromptAccepted.make({ prompt: "abcdef" }),
        ConversationEventSchema.cases.TurnEnded.make({ parts: echoParts("abcdef"), outcome: OutcomeSchema.cases.Completed.make({}) }),
      ])
      const replayed = messages.reduce((model, message) => program.update(model, message).model, init({ events: [] }).model)
      assert.deepStrictEqual(replayed, runtime.model())
    }).pipe(withNewSession),
  )

  it.effect("deltas that arrive together are one message; nothing waits for a clock", () =>
    Effect.gen(function* () {
      // One read from the agent carries three deltas, as one network chunk with several events would.
      const burst: ReadonlyArray<ChatChunk> = [
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "ab" },
        { type: "text-delta", id: "t", delta: "cd" },
        { type: "text-delta", id: "t", delta: "ef" },
        { type: "text-end", id: "t" },
      ]
      const runtime = yield* Runtime.make(program).pipe(providing(AgentService.layerScripted([burst])))
      const log = yield* Effect.forkChild(Stream.runCollect(Stream.takeUntil(runtime.messages, committed("1"))), {
        startImmediately: true,
      })

      runtime.dispatch(MessageSchema.cases.SubmittedPrompt.make({ text: "hi" }))
      // No clock advance: the whole turn runs on the scheduler alone.
      const messages = yield* Fiber.join(log)
      assert.strictEqual(assistantText(runtime), "abcdef")
      assert.deepStrictEqual(
        messages.filter(received).map((m) => (m._tag === "ReceivedChunk" && m.chunk.type === "text-delta" ? m.chunk.delta : "")),
        ["abcdef"],
      )
    }).pipe(withNewSession),
  )

  it.effect("escape cancels the stream mid-turn and commits the partial text", () =>
    Effect.gen(function* () {
      const runtime = yield* Runtime.make(program)
      const accept = yield* awaiting(runtime, accepted)
      const abc = yield* awaiting(runtime, received)
      const commit = yield* awaiting(runtime, committed("1"))

      runtime.dispatch(MessageSchema.cases.SubmittedPrompt.make({ text: "abcdef" }))
      yield* Fiber.join(accept)
      yield* advancingUntil(abc)
      const partial = assistantText(runtime)
      assert.isTrue(partial.length > 0 && partial.length < 6 && "abcdef".startsWith(partial))

      runtime.dispatch(MessageSchema.cases.PressedEscape.make({}))
      assert.deepStrictEqual(runtime.model().turn, TurnSchema.cases.Idle.make({}))
      yield* Fiber.join(commit)
      yield* TestClock.adjust("1 second")
      assert.strictEqual(assistantText(runtime), partial)

      const transcript = yield* loadTranscript
      assert.deepStrictEqual(
        transcript.at(-1),
        ConversationEventSchema.cases.TurnEnded.make({ parts: echoParts(partial), outcome: OutcomeSchema.cases.Cancelled.make({}) }),
      )
    }).pipe(withNewSession),
  )

  it.effect("a new prompt after cancellation starts a fresh stream", () =>
    Effect.gen(function* () {
      const runtime = yield* Runtime.make(program)
      const accept = yield* awaiting(runtime, accepted)
      const second = yield* awaiting(runtime, committed("3"))

      runtime.dispatch(MessageSchema.cases.SubmittedPrompt.make({ text: "ab" }))
      yield* Fiber.join(accept)
      runtime.dispatch(MessageSchema.cases.PressedEscape.make({}))
      runtime.dispatch(MessageSchema.cases.SubmittedPrompt.make({ text: "xy" }))
      yield* advancingUntil(second)
      assert.deepStrictEqual(texts(runtime), ["ab", "", "xy", "xy"])
      assert.deepStrictEqual(runtime.model().turn, TurnSchema.cases.Idle.make({}))
    }).pipe(withNewSession),
  )

  it.effect("a tool call runs the loop: the next step sees the result, and each step is recorded", () =>
    Effect.gen(function* () {
      const seen = yield* Ref.make<ReadonlyArray<ReadonlyArray<ChatMessage>>>([])
      const steps: ReadonlyArray<ReadonlyArray<ChatChunk>> = [makeReadCallChunks("call-1", "README.md"), makeTextChunks("A README.")]
      const inner = yield* Layer.build(AgentService.layerScripted(steps)).pipe(Effect.map((c) => Context.get(c, AgentService)))
      const scripted = AgentService.of({
        step: (messages, options) =>
          Stream.unwrap(
            Effect.as(
              Ref.update(seen, (all) => [...all, messages]),
              inner.step(messages, options),
            ),
          ),
      })
      const runtime = yield* Runtime.make(program).pipe(Effect.provideService(AgentService, scripted))
      const commit = yield* awaiting(runtime, committed("1"))

      runtime.dispatch(MessageSchema.cases.SubmittedPrompt.make({ text: "what is in the README?" }))
      yield* advancingUntil(commit)

      assert.deepStrictEqual(runtime.model().turn, TurnSchema.cases.Idle.make({}))
      assert.strictEqual(assistantText(runtime), "A README.")
      assert.deepStrictEqual(
        runtime.model().messages[1]?.parts.map((p) => p.type),
        ["step-start", "tool-read", "step-start", "text"],
      )

      // Round 1 was called with the tool result already in the message.
      const calls = yield* Ref.get(seen)
      assert.strictEqual(calls.length, 2)
      assert.deepStrictEqual(calls[0]?.[1]?.parts, [])
      const read = calls[1]?.[1]?.parts[1]
      assert.isTrue(read !== undefined && isToolUIPart(read) && read.state === "output-available")

      assert.deepStrictEqual(
        (yield* loadTranscript).map((e) => e._tag),
        ["PromptAccepted", "StepEnded", "TurnEnded"],
      )
      const restored = yield* Runtime.make(program).pipe(Effect.provideService(AgentService, scripted))
      assert.deepStrictEqual(restored.model(), runtime.model())
    }).pipe(withNewSession),
  )

  it.effect("an approval parks the turn across a restart; the answer resumes it", () =>
    Effect.gen(function* () {
      const steps: ReadonlyArray<ReadonlyArray<ChatChunk>> = [
        makeBashApprovalChunks("call-1", "approval-1"),
        [makeBashOutputChunk("call-1"), ...makeTextChunks("Done.")],
      ]
      // One agent for both runtimes: it plays its first step for the first, its second for the second.
      const scripted = yield* Layer.build(AgentService.layerScripted(steps)).pipe(Effect.map((c) => Context.get(c, AgentService)))
      const runtime = yield* Runtime.make(program).pipe(Effect.provideService(AgentService, scripted))
      const parked = yield* awaiting(runtime, (m) => m._tag === "SucceededCommitStep")

      runtime.dispatch(MessageSchema.cases.SubmittedPrompt.make({ text: "build it" }))
      yield* advancingUntil(parked)
      assert.deepStrictEqual(runtime.model().turn, TurnSchema.cases.AwaitingApproval.make({ messageId: "1", round: 0 }))

      // A second runtime over the same transcript is parked in the same place.
      const restored = yield* Runtime.make(program).pipe(Effect.provideService(AgentService, scripted))
      assert.deepStrictEqual(restored.model(), runtime.model())
      const commit = yield* awaiting(restored, committed("1"))
      restored.dispatch(MessageSchema.cases.RespondedToolApproval.make({ toolCallId: "call-1", approved: true }))
      assert.deepStrictEqual(restored.model().turn, TurnSchema.cases.Streaming.make({ messageId: "1", round: 1 }))
      yield* advancingUntil(commit)

      assert.deepStrictEqual(restored.model().turn, TurnSchema.cases.Idle.make({}))
      assert.strictEqual(assistantText(restored), "Done.")
      const bash = restored.model().messages[1]?.parts[1]
      assert.isTrue(bash !== undefined && isToolUIPart(bash) && bash.type === "tool-bash" && bash.state === "output-available")
      assert.deepStrictEqual(
        (yield* loadTranscript).map((e) => e._tag),
        ["PromptAccepted", "StepEnded", "TurnEnded"],
      )
    }).pipe(withNewSession),
  )

  it.effect("an agent failure becomes a failed outcome in the transcript", () =>
    Effect.gen(function* () {
      const failing = Layer.succeed(
        AgentService,
        AgentService.of({
          step: () =>
            Stream.make<ReadonlyArray<ChatChunk>>(
              { type: "start-step" },
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: "o" },
            ).pipe(Stream.concat(Stream.fail(AgentError.make({ message: "offline" })))),
        }),
      )
      const runtime = yield* Runtime.make(program).pipe(providing(failing))
      const commit = yield* awaiting(runtime, committed("1"))

      runtime.dispatch(MessageSchema.cases.SubmittedPrompt.make({ text: "hi" }))
      yield* advancingUntil(commit)
      assert.strictEqual(assistantText(runtime), "o")
      assert.deepStrictEqual(runtime.model().turn, TurnSchema.cases.Idle.make({}))
      assert.strictEqual(runtime.model().notice._tag, "Some")
      const transcript = yield* loadTranscript
      assert.deepStrictEqual(
        transcript.at(-1),
        ConversationEventSchema.cases.TurnEnded.make({
          parts: [{ type: "step-start" }, { type: "text", id: "t", text: "o", state: "done" }],
          outcome: OutcomeSchema.cases.Failed.make({ error: "offline" }),
        }),
      )
    }).pipe(withNewSession),
  )

  it.effect("a step that dies ends the turn as failed too, instead of leaving it streaming forever", () =>
    Effect.gen(function* () {
      const dying = Layer.succeed(
        AgentService,
        AgentService.of({
          step: () => Stream.make<ReadonlyArray<ChatChunk>>({ type: "start-step" }).pipe(Stream.concat(Stream.die(new Error("boom")))),
        }),
      )
      const runtime = yield* Runtime.make(program).pipe(providing(dying))
      const commit = yield* awaiting(runtime, committed("1"))

      runtime.dispatch(MessageSchema.cases.SubmittedPrompt.make({ text: "hi" }))
      yield* advancingUntil(commit)
      assert.isFalse(runtime.crashed())
      assert.deepStrictEqual(runtime.model().turn, TurnSchema.cases.Idle.make({}))
      assert.isTrue(Option.exists(runtime.model().notice, (notice) => notice.includes("boom")))
      const transcript = yield* loadTranscript
      assert.strictEqual(transcript.at(-1)?._tag, "TurnEnded")
    }).pipe(withNewSession),
  )

  it.effect("a transcript that refuses writes keeps the model clean and shows a notice", () =>
    Effect.gen(function* () {
      const readOnly = Layer.succeed(
        TranscriptService,
        TranscriptService.of({
          append: () => Effect.fail(PersistenceError.make({ message: "read only" })),
          load: () => Effect.succeed([]),
        }),
      )
      const runtime = yield* Runtime.make(program).pipe(providing(readOnly), Effect.provideService(CurrentSession, makeSession()))
      const refused = yield* awaiting(runtime, (m) => m._tag === "FailedAcceptPrompt")

      runtime.dispatch(MessageSchema.cases.SubmittedPrompt.make({ text: "hi" }))
      yield* Fiber.join(refused)
      assert.deepStrictEqual(runtime.model().messages, [])
      assert.deepStrictEqual(runtime.model().turn, TurnSchema.cases.Idle.make({}))
      assert.strictEqual(runtime.model().notice._tag, "Some")
    }),
  )

  it.effect("the next prompt is accepted while the previous turn is still being recorded", () =>
    Effect.gen(function* () {
      // A transcript with latency: every append waits on a gate, and appends are serialised (the contract).
      const gate = yield* Ref.make(yield* Deferred.make<void>())
      const events = yield* Ref.make<ReadonlyArray<ConversationEvent>>([])
      const permit = yield* Semaphore.make(1)
      const gated = Layer.succeed(
        TranscriptService,
        TranscriptService.of({
          append: (_, event) =>
            permit.withPermits(1)(
              Effect.andThen(
                Effect.flatMap(Ref.get(gate), Deferred.await),
                Ref.update(events, (all) => [...all, event]),
              ),
            ),
          load: () => Ref.get(events),
        }),
      )
      const open = Effect.flatMap(Ref.get(gate), (d) => Deferred.succeed(d, undefined))
      const close = Effect.flatMap(Deferred.make<void>(), (d) => Ref.set(gate, d))

      const runtime = yield* Runtime.make(program).pipe(providing(gated), Effect.provideService(CurrentSession, makeSession()))
      const accept = yield* awaiting(runtime, accepted)
      const abc = yield* awaiting(runtime, received)
      const ended = yield* awaiting(runtime, finished("1"))
      const second = yield* awaiting(runtime, committed("3"))

      yield* open
      runtime.dispatch(MessageSchema.cases.SubmittedPrompt.make({ text: "abcdef" }))
      yield* Fiber.join(accept)
      yield* advancingUntil(abc)
      assert.deepStrictEqual(runtime.model().turn, TurnSchema.cases.Streaming.make({ messageId: "1", round: 0 }))

      // Hold the transcript while turn one finishes: the turn ends at once, its record is in flight.
      yield* close
      yield* advancingUntil(ended)
      assert.deepStrictEqual(runtime.model().turn, TurnSchema.cases.Idle.make({}))
      assert.strictEqual(assistantText(runtime), "abcdef")
      assert.strictEqual((yield* Ref.get(events)).length, 1)

      // Turn two is not refused: it is accepted behind the held record.
      runtime.dispatch(MessageSchema.cases.SubmittedPrompt.make({ text: "xy" }))
      yield* TestClock.adjust("1 second")
      assert.deepStrictEqual(runtime.model().turn, TurnSchema.cases.Accepting.make({ prompt: "xy" }))
      assert.strictEqual(runtime.model().messages.length, 2)

      yield* open
      yield* advancingUntil(second)
      assert.deepStrictEqual(texts(runtime), ["abcdef", "abcdef", "xy", "xy"])
      assert.deepStrictEqual(runtime.model().turn, TurnSchema.cases.Idle.make({}))
      assert.deepStrictEqual(yield* Ref.get(events), [
        ConversationEventSchema.cases.PromptAccepted.make({ prompt: "abcdef" }),
        ConversationEventSchema.cases.TurnEnded.make({ parts: echoParts("abcdef"), outcome: OutcomeSchema.cases.Completed.make({}) }),
        ConversationEventSchema.cases.PromptAccepted.make({ prompt: "xy" }),
        ConversationEventSchema.cases.TurnEnded.make({ parts: echoParts("xy"), outcome: OutcomeSchema.cases.Completed.make({}) }),
      ])
    }),
  )

  it.effect("resume: a fresh program built from the transcript equals the live model", () =>
    Effect.gen(function* () {
      const live = yield* Runtime.make(program)
      const acceptFirst = yield* awaiting(live, accepted)
      const first = yield* awaiting(live, committed("1"))
      const second = yield* awaiting(live, committed("3"))

      live.dispatch(MessageSchema.cases.SubmittedPrompt.make({ text: "abc" }))
      yield* Fiber.join(acceptFirst)
      yield* advancingUntil(first)

      const acceptSecond = yield* awaiting(live, accepted)
      const def = yield* awaiting(live, (m) => m._tag === "ReceivedChunk" && m.chunk.type === "text-delta" && m.messageId === "3")
      live.dispatch(MessageSchema.cases.SubmittedPrompt.make({ text: "defg" }))
      yield* Fiber.join(acceptSecond)
      yield* advancingUntil(def)
      live.dispatch(MessageSchema.cases.PressedEscape.make({}))
      yield* Fiber.join(second)
      assert.deepStrictEqual(live.model().turn, TurnSchema.cases.Idle.make({}))
      const partial = textOf(live.model().messages[3])
      assert.isTrue(partial.length > 0 && partial.length < 4 && "defg".startsWith(partial))

      const restored = yield* Runtime.make(program)
      assert.deepStrictEqual(restored.model(), live.model())
      assert.deepStrictEqual(texts(restored), ["abc", "abc", "defg", partial])
    }).pipe(withNewSession),
  )
})

describe("coalesce", () => {
  const delta = (delta: string, id = "t") =>
    MessageSchema.cases.ReceivedChunk.make({ messageId: "1", round: 0, chunk: { type: "text-delta", id, delta } })

  it("merges adjacent deltas of the same part and keeps everything else in order", () => {
    const end = MessageSchema.cases.ReceivedChunk.make({ messageId: "1", round: 0, chunk: { type: "text-end", id: "t" } })
    assert.deepStrictEqual(coalesce([delta("a"), delta("b"), end, delta("c")]), [delta("ab"), end, delta("c")])
    assert.deepStrictEqual(coalesce([delta("a"), delta("b", "u")]), [delta("a"), delta("b", "u")])
    assert.deepStrictEqual(coalesce([end]), [end])
  })
})
