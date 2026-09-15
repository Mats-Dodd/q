import { assert, describe, it } from "@effect/vitest"

import { DelayReset, Message, init, update } from "./counter.fixture"
import { expectCommands, expectNoCommands, given, message, model, resolve, story } from "./story"

describe("story", () => {
  it("a message with no commands", () => {
    story(
      update,
      given(init().model),
      message(Message.cases.ClickedIncrement.make({})),
      expectNoCommands(),
      model((m) => assert.strictEqual(m.count, 1)),
    )
  })

  it("commands are inspected as data and resolved by feeding their result back", () => {
    story(
      update,
      given({ count: 5, isResetting: false }),
      message(Message.cases.ClickedResetAfterDelay.make({ seconds: 2 })),
      model((m) => assert.isTrue(m.isResetting)),
      expectCommands(DelayReset),
      resolve(DelayReset, Message.cases.CompletedDelayReset.make({})),
      model((m) => assert.deepStrictEqual(m, { count: 0, isResetting: false })),
    )
  })

  it("the command carries its args", () => {
    const [command] = update(init().model, Message.cases.ClickedResetAfterDelay.make({ seconds: 2 })).commands ?? []
    assert.strictEqual(command?.name, "DelayReset")
    assert.deepStrictEqual(command?.args, { seconds: 2 })
  })

  it("a story cannot move on with unresolved commands", () => {
    assert.throws(
      () =>
        story(
          update,
          given(init().model),
          message(Message.cases.ClickedResetAfterDelay.make({ seconds: 1 })),
          message(Message.cases.ClickedIncrement.make({})),
        ),
      /Resolve pending commands/,
    )
  })

  it("a story cannot end with unresolved commands", () => {
    assert.throws(
      () => story(update, given(init().model), message(Message.cases.ClickedResetAfterDelay.make({ seconds: 1 }))),
      /unresolved commands: DelayReset/,
    )
  })

  it("expectCommands is exact", () => {
    assert.throws(
      () => story(update, given(init().model), message(Message.cases.ClickedIncrement.make({})), expectCommands(DelayReset)),
      /Expected commands \[DelayReset\] but found \[\(none\)\]/,
    )
  })
})
