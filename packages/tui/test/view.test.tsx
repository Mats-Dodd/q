import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"

import { Resume, SessionTranscript, SqlTranscriptRepository, Transcript, makeEchoAgent } from "@q/core"

import { App } from "../src/view"

const trim = (frame: string) => frame.split("\n").map((line) => line.trimEnd()).join("\n")

/** The real transcript on a throwaway database. */
const sqlite = SessionTranscript(Resume.New(), "/test").pipe(
  Layer.provide(SqlTranscriptRepository),
  Layer.provide(SqliteClient.layer({ filename: ":memory:" })),
)

const mount = (delay: Parameters<typeof makeEchoAgent>[0], transcript: Layer.Layer<Transcript, unknown> = sqlite) =>
  testRender(() => <App layer={Layer.mergeAll(makeEchoAgent(delay), transcript)} />, {
    width: 40,
    height: 9,
    kittyKeyboard: true,
  })

/** A transcript that never answers: the prompt stays pending. */
const stuck = Layer.succeed(Transcript, { append: () => Effect.never, load: Effect.succeed([]) })

describe("view", () => {
  test("typing a prompt and pressing Enter echoes it back", async () => {
    const setup = await mount(null)
    try {
      await setup.waitForFrame((frame) => frame.includes("Type a message and press Enter."))

      await setup.mockInput.typeText("hello")
      setup.mockInput.pressEnter()
      await setup.waitForFrame((frame) => frame.includes("q › hello") && frame.includes("Enter sends"))

      const frame = trim(setup.captureCharFrame())
      expect(frame).toContain("you › hello")
      expect(frame).not.toContain("hellohello")
      expect(frame).toMatchSnapshot()
    } finally {
      setup.renderer.destroy()
    }
  })

  test("a prompt shows as pending while the transcript is still accepting it", async () => {
    const setup = await mount(null, stuck)
    try {
      await setup.waitForFrame((frame) => frame.includes("Type a message"))
      await setup.mockInput.typeText("hello")
      setup.mockInput.pressEnter()
      await setup.waitForFrame((frame) => frame.includes("sending"))

      const frame = trim(setup.captureCharFrame())
      expect(frame).toContain("you › hello")
      expect(frame).not.toContain("q ›")
      expect(frame).not.toContain("Type a message and press Enter.")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("escape cancels a streaming turn; a refused submit keeps the draft", async () => {
    const setup = await mount("10 seconds")
    try {
      await setup.waitForFrame((frame) => frame.includes("Type a message"))
      await setup.mockInput.typeText("hi")
      setup.mockInput.pressEnter()
      await setup.waitForFrame((frame) => frame.includes("streaming"))

      await setup.mockInput.typeText("draft")
      setup.mockInput.pressEnter()
      await setup.waitForVisualIdle()
      expect(setup.captureCharFrame()).toContain("draft")
      expect(setup.captureCharFrame()).not.toContain("you › draft")

      setup.mockInput.pressEscape()
      await setup.waitForFrame((frame) => frame.includes("Enter sends"))

      const frame = trim(setup.captureCharFrame())
      expect(frame).toContain("you › hi")
      expect(frame).toContain("q ›")
      expect(frame).not.toContain("q › h")
      expect(frame).toContain("draft")
    } finally {
      setup.renderer.destroy()
    }
  })
})
