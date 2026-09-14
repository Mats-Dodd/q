import { assert, expect, layer } from "@effect/vitest"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { testRender } from "@opentui/solid"
import { Duration, Effect, Layer } from "effect"

import { Agent, Resume, Transcript, TranscriptRepository } from "@q/core"

import { App } from "../src/view"

// The screen over the real program, on a throwaway database built once for the block. The clock is
// real: OpenTUI renders frames on it (`excludeTestServices`). Each test mounts its own `App` in the
// test's Scope; closing the Scope destroys the renderer.

const Sqlite = TranscriptRepository.Sql.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))

const trim = (frame: string) => frame.split("\n").map((line) => line.trimEnd()).join("\n")

/** A transcript that never answers: the prompt stays pending. */
const stuck = Layer.succeed(Transcript)({ append: () => Effect.never, load: Effect.succeed([]) })

/** Mount `App` with an echo agent of `delay` and a new session on the block's repository. */
const mount = (delay: Duration.Input | null, transcript?: Layer.Layer<Transcript, unknown>) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<TranscriptRepository>()
    const session = Transcript.Session(Resume.cases.New.make({}), "/test").pipe(Layer.provide(Layer.succeedContext(context)))
    return yield* Effect.acquireRelease(
      Effect.promise(() =>
        testRender(() => <App layer={Layer.mergeAll(Agent.Echo(delay), transcript ?? session)} />, {
          width: 40,
          height: 9,
          kittyKeyboard: true,
        }),
      ),
      (setup) => Effect.sync(() => setup.renderer.destroy()),
    )
  })

type Setup = Effect.Success<ReturnType<typeof mount>>

const waitForFrame = (setup: Setup, predicate: (frame: string) => boolean) =>
  Effect.promise(() => setup.waitForFrame(predicate))
const typeText = (setup: Setup, text: string) => Effect.promise(() => setup.mockInput.typeText(text))

layer(Sqlite, { excludeTestServices: true })("view", (it) => {
  it.effect("typing a prompt and pressing Enter echoes it back", () =>
    Effect.gen(function* () {
      const setup = yield* mount(null)
      yield* waitForFrame(setup, (frame) => frame.includes("Type a message and press Enter."))

      yield* typeText(setup, "hello")
      setup.mockInput.pressEnter()
      yield* waitForFrame(setup, (frame) => frame.includes("q › hello") && frame.includes("Enter sends"))

      const frame = trim(setup.captureCharFrame())
      assert.include(frame, "you › hello")
      assert.notInclude(frame, "hellohello")
      expect(frame).toMatchSnapshot()
    }),
  )

  it.effect("a prompt shows as pending while the transcript is still accepting it", () =>
    Effect.gen(function* () {
      const setup = yield* mount(null, stuck)
      yield* waitForFrame(setup, (frame) => frame.includes("Type a message"))
      yield* typeText(setup, "hello")
      setup.mockInput.pressEnter()
      yield* waitForFrame(setup, (frame) => frame.includes("sending"))

      const frame = trim(setup.captureCharFrame())
      assert.include(frame, "you › hello")
      assert.notInclude(frame, "q ›")
      assert.notInclude(frame, "Type a message and press Enter.")
    }),
  )

  it.effect("escape cancels a streaming turn; a refused submit keeps the draft", () =>
    Effect.gen(function* () {
      const setup = yield* mount("10 seconds")
      yield* waitForFrame(setup, (frame) => frame.includes("Type a message"))
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
})
