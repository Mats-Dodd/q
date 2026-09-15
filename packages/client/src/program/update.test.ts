import { assert, describe, it } from "@effect/vitest"
import { TurnSchema } from "@q/domain/conversation/model"
import { idleModel, makeStreamingModel } from "@q/factories/conversation-model"
import { booted, emit, expectCommands, expectNoCommands, given, message, model, resolve, story } from "@q/kit/story"
import { Option } from "effect"

import { Send, Watch } from "./command"
import { type Message, MessageSchema } from "./message"
import type { Model } from "./model"
import { canSubmit, init, update } from "./update"

const idle = idleModel
const streaming = makeStreamingModel("hi", "h")

const mirroring = (remote: typeof idle): Model => ({ remote: Option.some(remote), pending: Option.none(), notice: Option.none() })
const unchanged = (before: Model, msg: Message) => assert.strictEqual(update(before, msg).model, before)

describe("client update", () => {
  it("boot watches; the first Model fills the mirror", () => {
    story(
      update,
      booted(init()),
      model((m) => assert.isFalse(canSubmit(m))),
      expectCommands(Watch),
      emit(Watch, MessageSchema.cases.ReceivedModel.make({ model: idle })),
      model((m) => {
        assert.deepStrictEqual(m.remote, Option.some(idle))
        assert.isTrue(canSubmit(m))
      }),
      resolve(Watch, MessageSchema.cases.CompletedRequest.make({})),
    )
  })

  it("a prompt is pending until the server reflects it, and carries the intent", () => {
    story(
      update,
      given(mirroring(idle)),
      message(MessageSchema.cases.SubmittedPrompt.make({ text: "hi" })),
      model((m) => {
        assert.deepStrictEqual(m.pending, Option.some("hi"))
        assert.isFalse(canSubmit(m))
      }),
      expectCommands(Send),
      emit(Send, MessageSchema.cases.ReceivedModel.make({ model: streaming })),
      model((m) => {
        assert.deepStrictEqual(m.pending, Option.none())
        assert.deepStrictEqual(m.remote, Option.some(streaming))
        assert.isFalse(canSubmit(m))
      }),
      emit(Send, MessageSchema.cases.ReceivedModel.make({ model: { ...streaming, turn: TurnSchema.cases.Idle.make({}) } })),
      model((m) => assert.isTrue(canSubmit(m))),
      resolve(Send, MessageSchema.cases.CompletedRequest.make({})),
    )
    const [command] = update(mirroring(idle), MessageSchema.cases.SubmittedPrompt.make({ text: "hi" })).commands ?? []
    assert.deepStrictEqual(command?.args, { intent: { _tag: "SubmittedPrompt", text: "hi" } })
  })

  it("a prompt is refused while pending, while the server is busy, before the first Model, or blank", () => {
    unchanged(init().model, MessageSchema.cases.SubmittedPrompt.make({ text: "hi" }))
    unchanged(mirroring(streaming), MessageSchema.cases.SubmittedPrompt.make({ text: "hi" }))
    unchanged({ ...mirroring(idle), pending: Option.some("one") }, MessageSchema.cases.SubmittedPrompt.make({ text: "two" }))
    unchanged(mirroring(idle), MessageSchema.cases.SubmittedPrompt.make({ text: "  " }))
  })

  it("escape cancels a running turn, and otherwise refreshes the mirror", () => {
    const [cancel] = update(mirroring(streaming), MessageSchema.cases.PressedEscape.make({})).commands ?? []
    assert.strictEqual(cancel?.name, "Send")
    assert.deepStrictEqual(cancel?.args, { intent: { _tag: "PressedEscape" } })
    const [refresh] = update(mirroring(idle), MessageSchema.cases.PressedEscape.make({})).commands ?? []
    assert.strictEqual(refresh?.name, "Watch")
  })

  it("a failed request clears the pending prompt and shows a notice, which the next request clears", () => {
    story(
      update,
      given(mirroring(idle)),
      message(MessageSchema.cases.SubmittedPrompt.make({ text: "hi" })),
      resolve(Send, MessageSchema.cases.FailedRequest.make({ error: "cannot reach the server" })),
      model((m) => {
        assert.deepStrictEqual(m.pending, Option.none())
        assert.deepStrictEqual(m.notice, Option.some("cannot reach the server"))
        assert.isTrue(canSubmit(m))
      }),
      message(MessageSchema.cases.SubmittedPrompt.make({ text: "again" })),
      model((m) => assert.deepStrictEqual(m.notice, Option.none())),
      resolve(Send, MessageSchema.cases.CompletedRequest.make({})),
    )
  })

  it("a completed request with no Models changes nothing but pending", () => {
    story(
      update,
      given(mirroring(idle)),
      message(MessageSchema.cases.CompletedRequest.make({})),
      expectNoCommands(),
      model((m) => assert.deepStrictEqual(m, mirroring(idle))),
    )
  })
})
