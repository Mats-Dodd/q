import { assert, describe, it } from "@effect/vitest"
import { Schema } from "effect"

import { DelayReset, Message, init, update } from "./counter.fixture"
import { defineTaggedUnion } from "../src/schema"
import { expectCommands, expectNoCommands, given, message, model, resolve, story } from "../src/testing"

describe("schema", () => {
  it("variants are callable constructors and the union matches exhaustively", () => {
    const Shape = defineTaggedUnion({ Dot: {}, Circle: { radius: Schema.Number } })
    assert.deepStrictEqual(Shape.Dot(), { _tag: "Dot" })
    assert.deepStrictEqual(Shape.Circle({ radius: 2 }), { _tag: "Circle", radius: 2 })
    const area = Shape.match({ Dot: () => 0, Circle: ({ radius }) => radius * radius })
    assert.strictEqual(area(Shape.Circle({ radius: 3 })), 9)
    assert.isTrue(Schema.is(Shape)({ _tag: "Circle", radius: 1 }))
    assert.isFalse(Schema.is(Shape)({ _tag: "Square" }))
  })

  it("variant names cannot shadow union members", () => {
    assert.throws(() => defineTaggedUnion({ match: {} }), /conflict/)
  })
})

describe("story", () => {
  it("a message with no commands", () => {
    story(
      update,
      given(init().model),
      message(Message.ClickedIncrement()),
      expectNoCommands(),
      model((m) => assert.strictEqual(m.count, 1)),
    )
  })

  it("commands are inspected as data and resolved by feeding their result back", () => {
    story(
      update,
      given({ count: 5, isResetting: false }),
      message(Message.ClickedResetAfterDelay({ seconds: 2 })),
      model((m) => assert.isTrue(m.isResetting)),
      expectCommands(DelayReset),
      resolve(DelayReset, Message.CompletedDelayReset()),
      model((m) => assert.deepStrictEqual(m, { count: 0, isResetting: false })),
    )
  })

  it("the command carries its args", () => {
    const [command] = update(init().model, Message.ClickedResetAfterDelay({ seconds: 2 })).commands ?? []
    assert.strictEqual(command?.name, "DelayReset")
    assert.deepStrictEqual(command?.args, { seconds: 2 })
  })

  it("a story cannot move on with unresolved commands", () => {
    assert.throws(
      () =>
        story(
          update,
          given(init().model),
          message(Message.ClickedResetAfterDelay({ seconds: 1 })),
          message(Message.ClickedIncrement()),
        ),
      /Resolve pending commands/,
    )
  })

  it("a story cannot end with unresolved commands", () => {
    assert.throws(
      () => story(update, given(init().model), message(Message.ClickedResetAfterDelay({ seconds: 1 }))),
      /unresolved commands: DelayReset/,
    )
  })

  it("expectCommands is exact", () => {
    assert.throws(
      () => story(update, given(init().model), message(Message.ClickedIncrement()), expectCommands(DelayReset)),
      /Expected commands \[DelayReset\] but found \[\(none\)\]/,
    )
  })
})
