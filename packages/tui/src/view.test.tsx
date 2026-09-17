import { assert, expect, it } from "@effect/vitest"
import { testRender } from "@opentui/solid"
import { openSession, Transport } from "@q/client/transport/transport-service"
import { IntentSchema } from "@q/domain/conversation/model"
import type { Intent } from "@q/domain/conversation/model"
import { ResumeSchema } from "@q/domain/session/model"
import {
  makeAnsweredModel,
  makeAssistantMessage,
  makeAwaitingApprovalModel,
  makeStreamingModel,
  makeTextStep,
  makeUserMessage,
} from "@q/factories/conversation-model"
import { defaultSessionsHandlers, makeApiClientTest } from "@q/test/api-mock/layer"
import type { SessionsHandlersTest } from "@q/test/api-mock/layer"
import { Effect, Layer, Stream } from "effect"

import { App } from "./view"

// The screen over the client program, against a scripted server behind the real `ApiClient`. The
// clock is real: OpenTUI renders frames on it (`it.live`). Each test mounts its own `App` in the
// test's Scope; closing the Scope destroys the renderer.

const trim = (frame: string) =>
  frame
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")

/** Mount `App` over a server with `handlers`, on a new session. */
const mount = (handlers: SessionsHandlersTest = defaultSessionsHandlers) =>
  Effect.gen(function* () {
    const services = yield* Layer.build(makeApiClientTest(handlers))
    const session = yield* openSession("/test", ResumeSchema.cases.New.make({})).pipe(Effect.provide(services))
    const transport = Transport.layer(session.id).pipe(Layer.provide(Layer.succeedContext(services)))
    return yield* Effect.acquireRelease(
      Effect.promise(() => testRender(() => <App layer={transport} />, { width: 40, height: 9, kittyKeyboard: true })),
      (setup) => Effect.sync(() => setup.renderer.destroy()),
    )
  })

type Setup = Effect.Success<ReturnType<typeof mount>>

const waitForFrame = (setup: Setup, predicate: (frame: string) => boolean) => Effect.promise(() => setup.waitForFrame(predicate))
const typeText = (setup: Setup, text: string) => Effect.promise(() => setup.mockInput.typeText(text))

it.live("typing a prompt and pressing Enter echoes it back", () =>
  Effect.gen(function* () {
    const setup = yield* mount()
    yield* waitForFrame(setup, (frame) => frame.includes("Type a message and press Enter.") && frame.includes("Enter sends"))

    yield* typeText(setup, "hello")
    setup.mockInput.pressEnter()
    yield* waitForFrame(setup, (frame) => frame.includes("q › hello") && frame.includes("Enter sends"))

    const frame = trim(setup.captureCharFrame())
    assert.include(frame, "you › hello")
    assert.notInclude(frame, "hellohello")
    expect(frame).toMatchSnapshot("echoed")
  }),
)

it.live("a prompt shows as pending while the server is still accepting it", () =>
  Effect.gen(function* () {
    // A server that never answers the intent: the prompt stays pending.
    const setup = yield* mount({ ...defaultSessionsHandlers, sendIntent: () => Effect.succeed(Stream.never) })
    yield* waitForFrame(setup, (frame) => frame.includes("Type a message") && frame.includes("Enter sends"))
    yield* typeText(setup, "hello")
    setup.mockInput.pressEnter()
    yield* waitForFrame(setup, (frame) => frame.includes("sending"))

    const frame = trim(setup.captureCharFrame())
    assert.include(frame, "you › hello")
    assert.notInclude(frame, "q ›")
    assert.notInclude(frame, "Type a message and press Enter.")
  }),
)

it.live("escape cancels a streaming turn; a refused submit keeps the draft", () =>
  Effect.gen(function* () {
    // A prompt starts a turn that never ends on its own; escape ends it with nothing produced.
    const setup = yield* mount({
      ...defaultSessionsHandlers,
      sendIntent: (_, intent) =>
        Effect.succeed(
          intent._tag === "SubmittedPrompt"
            ? Stream.concat(Stream.make(makeStreamingModel(intent.text, "")), Stream.never)
            : Stream.make(makeAnsweredModel("hi", "")),
        ),
    })
    yield* waitForFrame(setup, (frame) => frame.includes("Type a message") && frame.includes("Enter sends"))
    yield* typeText(setup, "hi")
    setup.mockInput.pressEnter()
    yield* waitForFrame(setup, (frame) => frame.includes("streaming"))

    yield* typeText(setup, "draft")
    setup.mockInput.pressEnter()
    yield* Effect.promise(() => setup.waitForVisualIdle())
    assert.include(setup.captureCharFrame(), "draft")
    assert.notInclude(setup.captureCharFrame(), "you › draft")

    setup.mockInput.pressEscape()
    yield* waitForFrame(setup, (frame) => frame.includes("Enter sends"))

    const frame = trim(setup.captureCharFrame())
    assert.include(frame, "you › hi")
    assert.include(frame, "q ›")
    assert.notInclude(frame, "q › h")
    assert.include(frame, "draft")
  }),
)

it.live("a tool call is a line of its own; an approval request takes y or n from the keyboard", () =>
  Effect.gen(function* () {
    const parked = makeAwaitingApprovalModel("build it")
    const sent = makeAnsweredModel("build it", "Done.", {
      messages: [
        makeUserMessage("0", "build it"),
        makeAssistantMessage("1", [
          { type: "step-start" },
          {
            type: "tool-bash",
            toolCallId: "call-1",
            state: "output-available",
            input: { command: "make" },
            output: { exitCode: 0, output: "", truncated: false, timedOut: false },
            approval: { id: "approval-1", approved: true },
          },
          ...makeTextStep("Done."),
        ]),
      ],
    })
    const answers: Array<Intent> = []
    const setup = yield* mount({
      ...defaultSessionsHandlers,
      sendIntent: (_, intent) => {
        answers.push(intent)
        return Effect.succeed(Stream.make(intent._tag === "SubmittedPrompt" ? parked : sent))
      },
    })
    yield* waitForFrame(setup, (frame) => frame.includes("Type a message") && frame.includes("Enter sends"))
    yield* typeText(setup, "build it")
    setup.mockInput.pressEnter()
    yield* waitForFrame(setup, (frame) => frame.includes("approve bash? y / n"))

    const asked = trim(setup.captureCharFrame())
    assert.include(asked, "you › build it")
    assert.include(asked, "⚙ bash(make)")
    assert.include(asked, "approve? y / n")
    expect(asked).toMatchSnapshot("asked")

    // `y` is an answer, not a character of the draft.
    yield* typeText(setup, "y")
    yield* waitForFrame(setup, (frame) => frame.includes("Enter sends"))
    const done = trim(setup.captureCharFrame())
    assert.include(done, "q › ⚙ bash(make) → exit 0")
    assert.include(done, "Done.")
    assert.notInclude(done, "│ y")
    assert.deepStrictEqual(answers.at(-1), IntentSchema.cases.RespondedToolApproval.make({ toolCallId: "call-1", approved: true }))
    expect(done).toMatchSnapshot("answered")
  }),
)
