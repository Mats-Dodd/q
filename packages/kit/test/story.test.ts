import { describe, expect, test } from "bun:test"
import { Schema } from "effect"

import { DelayReset, Message, init, update } from "./counter.fixture"
import { defineTaggedUnion } from "../src/schema"
import { expectCommands, expectNoCommands, given, message, model, resolve, story } from "../src/testing"

describe("schema", () => {
  test("variants are callable constructors and the union matches exhaustively", () => {
    const Shape = defineTaggedUnion({ Dot: {}, Circle: { radius: Schema.Number } })
    expect(Shape.Dot()).toEqual({ _tag: "Dot" })
    expect(Shape.Circle({ radius: 2 })).toEqual({ _tag: "Circle", radius: 2 })
    const area = Shape.match({ Dot: () => 0, Circle: ({ radius }) => radius * radius })
    expect(area(Shape.Circle({ radius: 3 }))).toBe(9)
    expect(Schema.is(Shape)({ _tag: "Circle", radius: 1 })).toBe(true)
    expect(Schema.is(Shape)({ _tag: "Square" })).toBe(false)
  })

  test("variant names cannot shadow union members", () => {
    expect(() => defineTaggedUnion({ match: {} })).toThrow(/conflict/)
  })
})

describe("story", () => {
  test("a message with no commands", () => {
    story(
      update,
      given(init().model),
      message(Message.ClickedIncrement()),
      expectNoCommands(),
      model((m) => expect(m.count).toBe(1)),
    )
  })

  test("commands are inspected as data and resolved by feeding their result back", () => {
    story(
      update,
      given({ count: 5, isResetting: false }),
      message(Message.ClickedResetAfterDelay({ seconds: 2 })),
      model((m) => expect(m.isResetting).toBe(true)),
      expectCommands(DelayReset),
      resolve(DelayReset, Message.CompletedDelayReset()),
      model((m) => expect(m).toEqual({ count: 0, isResetting: false })),
    )
  })

  test("the command carries its args", () => {
    const [command] = update(init().model, Message.ClickedResetAfterDelay({ seconds: 2 })).commands ?? []
    expect(command?.name).toBe("DelayReset")
    expect(command?.args).toEqual({ seconds: 2 })
  })

  test("a story cannot move on with unresolved commands", () => {
    expect(() =>
      story(
        update,
        given(init().model),
        message(Message.ClickedResetAfterDelay({ seconds: 1 })),
        message(Message.ClickedIncrement()),
      ),
    ).toThrow(/Resolve pending commands/)
  })

  test("a story cannot end with unresolved commands", () => {
    expect(() =>
      story(update, given(init().model), message(Message.ClickedResetAfterDelay({ seconds: 1 }))),
    ).toThrow(/unresolved commands: DelayReset/)
  })

  test("expectCommands is exact", () => {
    expect(() => story(update, given(init().model), message(Message.ClickedIncrement()), expectCommands(DelayReset))).toThrow(
      /Expected commands \[DelayReset\] but found \[\(none\)\]/,
    )
  })
})
