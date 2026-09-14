import { assert, describe, it } from "@effect/vitest"
import { Option } from "effect"

import { Model as Remote, Turn } from "@q/core"
import { booted, emit, expectCommands, expectNoCommands, given, message, model, resolve, story } from "@q/kit/testing"
import { Message, type Model, Send, Watch, canSubmit, init, update } from "../src/program"

const idle: Remote = { messages: [], turn: Turn.cases.Idle.make({}), nextId: 0, notice: Option.none() }
const streaming: Remote = {
  messages: [
    { id: 0, role: "user", text: "hi" },
    { id: 1, role: "assistant", text: "h" },
  ],
  turn: Turn.cases.Streaming.make({ messageId: 1, prompt: "hi" }),
  nextId: 2,
  notice: Option.none(),
}

const mirroring = (remote: Remote): Model => ({ remote: Option.some(remote), pending: Option.none(), notice: Option.none() })
const unchanged = (before: Model, msg: Message) => assert.strictEqual(update(before, msg).model, before)

describe("client update", () => {
  it("boot watches; the first Model fills the mirror", () => {
    story(
      update,
      booted(init()),
      model((m) => assert.isFalse(canSubmit(m))),
      expectCommands(Watch),
      emit(Watch, Message.cases.ReceivedModel.make({ model: idle })),
      model((m) => {
        assert.deepStrictEqual(m.remote, Option.some(idle))
        assert.isTrue(canSubmit(m))
      }),
      resolve(Watch, Message.cases.CompletedRequest.make({})),
    )
  })

  it("a prompt is pending until the server reflects it, and carries the intent", () => {
    story(
      update,
      given(mirroring(idle)),
      message(Message.cases.SubmittedPrompt.make({ text: "hi" })),
      model((m) => {
        assert.deepStrictEqual(m.pending, Option.some("hi"))
        assert.isFalse(canSubmit(m))
      }),
      expectCommands(Send),
      emit(Send, Message.cases.ReceivedModel.make({ model: streaming })),
      model((m) => {
        assert.deepStrictEqual(m.pending, Option.none())
        assert.deepStrictEqual(m.remote, Option.some(streaming))
        assert.isFalse(canSubmit(m))
      }),
      emit(Send, Message.cases.ReceivedModel.make({ model: { ...streaming, turn: Turn.cases.Idle.make({}) } })),
      model((m) => assert.isTrue(canSubmit(m))),
      resolve(Send, Message.cases.CompletedRequest.make({})),
    )
    const [command] = update(mirroring(idle), Message.cases.SubmittedPrompt.make({ text: "hi" })).commands ?? []
    assert.deepStrictEqual(command?.args, { intent: { _tag: "SubmittedPrompt", text: "hi" } })
  })

  it("a prompt is refused while pending, while the server is busy, before the first Model, or blank", () => {
    unchanged(init().model, Message.cases.SubmittedPrompt.make({ text: "hi" }))
    unchanged(mirroring(streaming), Message.cases.SubmittedPrompt.make({ text: "hi" }))
    unchanged({ ...mirroring(idle), pending: Option.some("one") }, Message.cases.SubmittedPrompt.make({ text: "two" }))
    unchanged(mirroring(idle), Message.cases.SubmittedPrompt.make({ text: "  " }))
  })

  it("escape cancels a running turn, and otherwise refreshes the mirror", () => {
    const [cancel] = update(mirroring(streaming), Message.cases.PressedEscape.make({})).commands ?? []
    assert.strictEqual(cancel?.name, "Send")
    assert.deepStrictEqual(cancel?.args, { intent: { _tag: "PressedEscape" } })
    const [refresh] = update(mirroring(idle), Message.cases.PressedEscape.make({})).commands ?? []
    assert.strictEqual(refresh?.name, "Watch")
  })

  it("a failed request clears the pending prompt and shows a notice, which the next request clears", () => {
    story(
      update,
      given(mirroring(idle)),
      message(Message.cases.SubmittedPrompt.make({ text: "hi" })),
      resolve(Send, Message.cases.FailedRequest.make({ error: "cannot reach the server" })),
      model((m) => {
        assert.deepStrictEqual(m.pending, Option.none())
        assert.deepStrictEqual(m.notice, Option.some("cannot reach the server"))
        assert.isTrue(canSubmit(m))
      }),
      message(Message.cases.SubmittedPrompt.make({ text: "again" })),
      model((m) => assert.deepStrictEqual(m.notice, Option.none())),
      resolve(Send, Message.cases.CompletedRequest.make({})),
    )
  })

  it("a completed request with no Models changes nothing but pending", () => {
    story(update, given(mirroring(idle)), message(Message.cases.CompletedRequest.make({})), expectNoCommands(), model((m) => assert.deepStrictEqual(m, mirroring(idle))))
  })
})
