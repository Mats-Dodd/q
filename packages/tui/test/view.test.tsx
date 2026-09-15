import { assert, expect, layer } from "@effect/vitest"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { testRender } from "@opentui/solid"
import { Context, type Duration, Effect, FileSystem, Layer, Path } from "effect"
import { Etag, HttpPlatform } from "effect/unstable/http"

import { Client, Transport, open } from "@q/client"
import { Agent, Resume, TranscriptRepository } from "@q/core"
import { Sql } from "@q/db"
import { Sessions, SessionsHandlers } from "@q/server"

import { App } from "../src/view"

// The screen over the client program, against a server in the same process. The clock is real:
// OpenTUI renders frames on it (`excludeTestServices`). Each test mounts its own `App`, with its
// own server, in the test's Scope; closing the Scope destroys the renderer.

const Platform = Layer.mergeAll(Path.layer, Etag.layerWeak, HttpPlatform.layer).pipe(Layer.provideMerge(FileSystem.layerNoop({})))

/** The real repository on a throwaway SQLite database. */
const Sqlite = Sql.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))

const trim = (frame: string) => frame.split("\n").map((line) => line.trimEnd()).join("\n")

/** A repository that never finishes an append: the prompt stays pending. */
const stuck = Layer.effect(TranscriptRepository)(
  Effect.gen(function* () {
    const sqlite = Context.get(yield* Layer.build(Sqlite), TranscriptRepository)
    return { ...sqlite, append: () => Effect.never }
  }),
)

/** Mount `App` over a fresh server with an echo agent of `delay`, on a new session. */
const mount = (delay: Duration.Input | null, repository: Layer.Layer<TranscriptRepository, unknown> = Sqlite) =>
  Effect.gen(function* () {
    const server = yield* Layer.build(
      SessionsHandlers.pipe(Layer.provide(Sessions.layer()), Layer.provide(Layer.mergeAll(Agent.Echo(delay), repository))),
    )
    const platform = yield* Effect.context<Layer.Success<typeof Platform>>()
    const services = Context.merge(server, platform)
    const session = yield* open(yield* Client.local.pipe(Effect.provide(services)), "/test", Resume.cases.New.make({}))
    const transport = Transport.Local(session.id).pipe(Layer.provide(Layer.succeedContext(services)))
    return yield* Effect.acquireRelease(
      Effect.promise(() =>
        testRender(() => <App layer={transport} />, {
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

layer(Platform, { excludeTestServices: true })("view", (it) => {
  it.effect("typing a prompt and pressing Enter echoes it back", () =>
    Effect.gen(function* () {
      const setup = yield* mount(null)
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

  it.effect("a prompt shows as pending while the server is still accepting it", () =>
    Effect.gen(function* () {
      const setup = yield* mount(null, stuck)
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

  it.effect("escape cancels a streaming turn; a refused submit keeps the draft", () =>
    Effect.gen(function* () {
      const setup = yield* mount("10 seconds")
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
})
