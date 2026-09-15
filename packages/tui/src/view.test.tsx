import { assert, expect, it } from "@effect/vitest"
import { testRender } from "@opentui/solid"
import { openSession, Transport } from "@q/client/transport/transport-service"
import { ResumeSchema } from "@q/domain/session/model"
import { makeAnsweredModel, makeStreamingModel } from "@q/factories/conversation-model"
import { defaultSessionsHandlers, makeApiClientTest, type SessionsHandlersTest } from "@q/test/api-mock/layer"
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
    expect(frame).toMatchSnapshot()
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
