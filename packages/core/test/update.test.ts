import { assert, describe, it } from "@effect/vitest"
import { Option } from "effect"

import { expectCommands, expectNoCommands, given, meanwhile, message, model, resolve, story } from "@q/kit/testing"
import { AcceptPrompt, CommitTurn } from "../src/command"
import { ConversationEvent, Outcome } from "../src/domain/event"
import { type Model, Turn } from "../src/domain/model"
import { Message } from "../src/message"
import { init, update } from "../src/update"

const fresh = () => init({ events: [] }).model

/** Drive a fresh model to `Streaming` on the prompt "hi": rows 0 (user) and 1 (assistant). */
const streaming = (): Model =>
  story(
    update,
    given(fresh()),
    message(Message.cases.SubmittedPrompt.make({ text: "hi" })),
    resolve(AcceptPrompt, Message.cases.SucceededAcceptPrompt.make({})),
  ).model

const unchanged = (before: Model, msg: Message) => assert.strictEqual(update(before, msg).model, before)

describe("write-ahead turn", () => {
  it("a prompt is not on screen until the transcript accepts it", () => {
    story(
      update,
      given(fresh()),
      message(Message.cases.SubmittedPrompt.make({ text: "hello" })),
      model((m) => {
        assert.deepStrictEqual(m.messages, [])
        assert.deepStrictEqual(m.turn, Turn.cases.Accepting.make({ prompt: "hello" }))
      }),
      expectCommands(AcceptPrompt),
      resolve(AcceptPrompt, Message.cases.SucceededAcceptPrompt.make({})),
      model((m) => {
        assert.deepStrictEqual(m.messages, [
          { id: 0, role: "user", text: "hello" },
          { id: 1, role: "assistant", text: "" },
        ])
        assert.deepStrictEqual(m.turn, Turn.cases.Streaming.make({ messageId: 1, prompt: "hello" }))
        assert.strictEqual(m.nextId, 2)
      }),
    )
  })

  it("the accept command carries the prompt", () => {
    const [command] = update(fresh(), Message.cases.SubmittedPrompt.make({ text: "hello" })).commands ?? []
    assert.strictEqual(command?.name, "AcceptPrompt")
    assert.deepStrictEqual(command?.args, { prompt: "hello" })
  })

  it("a rejected prompt leaves no row and shows a notice", () => {
    story(
      update,
      given(fresh()),
      message(Message.cases.SubmittedPrompt.make({ text: "hello" })),
      resolve(AcceptPrompt, Message.cases.FailedAcceptPrompt.make({ error: "disk full" })),
      model((m) => {
        assert.deepStrictEqual(m.messages, [])
        assert.deepStrictEqual(m.turn, Turn.cases.Idle.make({}))
        assert.deepStrictEqual(m.notice, Option.some("could not save prompt: disk full"))
      }),
      message(Message.cases.SubmittedPrompt.make({ text: "again" })),
      model((m) => assert.deepStrictEqual(m.notice, Option.none())),
      resolve(AcceptPrompt, Message.cases.SucceededAcceptPrompt.make({})),
    )
  })

  it("completion ends the turn at once and records the full text behind it", () => {
    story(
      update,
      given(streaming()),
      message(Message.cases.ReceivedText.make({ messageId: 1, text: "he" })),
      message(Message.cases.ReceivedText.make({ messageId: 1, text: "llo" })),
      message(Message.cases.CompletedTurn.make({ messageId: 1 })),
      model((m) => {
        assert.strictEqual(m.messages[1]?.text, "hello")
        assert.deepStrictEqual(m.turn, Turn.cases.Idle.make({}))
      }),
      expectCommands(CommitTurn),
      resolve(CommitTurn, Message.cases.SucceededCommitTurn.make({ messageId: 1 })),
      model((m) => assert.deepStrictEqual(m.turn, Turn.cases.Idle.make({}))),
    )
  })

  it("a saved turn is a fact the model does not need", () => {
    const idle = update(streaming(), Message.cases.CompletedTurn.make({ messageId: 1 })).model
    unchanged(idle, Message.cases.SucceededCommitTurn.make({ messageId: 1 }))
  })

  it("the commit command carries the text and outcome", () => {
    const withText = update(streaming(), Message.cases.ReceivedText.make({ messageId: 1, text: "partial" })).model
    const [command] = update(withText, Message.cases.PressedEscape.make({})).commands ?? []
    assert.strictEqual(command?.name, "CommitTurn")
    assert.deepStrictEqual(command?.args, { messageId: 1, text: "partial", outcome: Outcome.cases.Cancelled.make({}) })
  })

  it("an agent failure records the error on the row and commits a failed outcome", () => {
    const [command] = update(streaming(), Message.cases.FailedTurn.make({ messageId: 1, error: "offline" })).commands ?? []
    assert.deepStrictEqual(command?.args, { messageId: 1, text: " [error: offline]", outcome: Outcome.cases.Failed.make({ error: "offline" }) })
  })

  it("a failed commit is a notice; the row stays", () => {
    story(
      update,
      given(streaming()),
      message(Message.cases.CompletedTurn.make({ messageId: 1 })),
      resolve(CommitTurn, Message.cases.FailedCommitTurn.make({ messageId: 1, error: "timeout" })),
      model((m) => {
        assert.strictEqual(m.messages.length, 2)
        assert.deepStrictEqual(m.turn, Turn.cases.Idle.make({}))
        assert.deepStrictEqual(m.notice, Option.some("could not save turn: timeout"))
      }),
    )
  })

  it("a failed commit landing during the next turn sets the notice and nothing else", () => {
    const next = story(
      update,
      given(streaming()),
      message(Message.cases.CompletedTurn.make({ messageId: 1 })),
      meanwhile(Message.cases.SubmittedPrompt.make({ text: "next" })),
      resolve(AcceptPrompt, Message.cases.SucceededAcceptPrompt.make({})),
      resolve(CommitTurn, Message.cases.FailedCommitTurn.make({ messageId: 1, error: "timeout" })),
    ).model
    assert.deepStrictEqual(next.turn, Turn.cases.Streaming.make({ messageId: 3, prompt: "next" }))
    assert.strictEqual(next.messages.length, 4)
    assert.deepStrictEqual(next.notice, Option.some("could not save turn: timeout"))
  })

  it("tokens append to the assistant row and leave every other row untouched by reference", () => {
    const before = streaming()
    const after = update(before, Message.cases.ReceivedText.make({ messageId: 1, text: "h" })).model
    assert.strictEqual(after.messages[1]?.text, "h")
    assert.strictEqual(after.messages[0], before.messages[0]!)
    assert.strictEqual(after.turn, before.turn)
  })
})

describe("messages that do not fit the current state are ignored by reference", () => {
  it("blank prompt, prompt while not idle", () => {
    unchanged(fresh(), Message.cases.SubmittedPrompt.make({ text: "   " }))
    const accepting = update(fresh(), Message.cases.SubmittedPrompt.make({ text: "one" })).model
    unchanged(accepting, Message.cases.SubmittedPrompt.make({ text: "two" }))
    unchanged(streaming(), Message.cases.SubmittedPrompt.make({ text: "two" }))
  })

  it("escape while idle or accepting", () => {
    unchanged(fresh(), Message.cases.PressedEscape.make({}))
    unchanged(update(fresh(), Message.cases.SubmittedPrompt.make({ text: "one" })).model, Message.cases.PressedEscape.make({}))
    unchanged(update(streaming(), Message.cases.CompletedTurn.make({ messageId: 1 })).model, Message.cases.PressedEscape.make({}))
  })

  it("text, completion and failure for a foreign or finished turn", () => {
    const live = streaming()
    unchanged(live, Message.cases.ReceivedText.make({ messageId: 0, text: "x" }))
    unchanged(live, Message.cases.ReceivedText.make({ messageId: 99, text: "x" }))
    unchanged(live, Message.cases.CompletedTurn.make({ messageId: 99 }))
    unchanged(live, Message.cases.FailedTurn.make({ messageId: 99, error: "x" }))

    const ended = update(live, Message.cases.PressedEscape.make({})).model
    unchanged(ended, Message.cases.ReceivedText.make({ messageId: 1, text: "late" }))
    unchanged(ended, Message.cases.CompletedTurn.make({ messageId: 1 }))
    unchanged(ended, Message.cases.FailedTurn.make({ messageId: 1, error: "late" }))
  })

  it("a stale completion from a cancelled turn cannot end the next turn", () => {
    const second = story(
      update,
      given(streaming()),
      message(Message.cases.PressedEscape.make({})),
      resolve(CommitTurn, Message.cases.SucceededCommitTurn.make({ messageId: 1 })),
      message(Message.cases.SubmittedPrompt.make({ text: "next" })),
      resolve(AcceptPrompt, Message.cases.SucceededAcceptPrompt.make({})),
      model((m) => assert.deepStrictEqual(m.turn, Turn.cases.Streaming.make({ messageId: 3, prompt: "next" }))),
    )
    unchanged(second.model, Message.cases.CompletedTurn.make({ messageId: 1 }))
    unchanged(second.model, Message.cases.SucceededCommitTurn.make({ messageId: 1 }))
  })

  it("accept results while idle", () => {
    unchanged(fresh(), Message.cases.SucceededAcceptPrompt.make({}))
    unchanged(fresh(), Message.cases.FailedAcceptPrompt.make({ error: "x" }))
  })
})

describe("init folds the transcript", () => {
  it("completed turns become rows, and the model is idle", () => {
    const m = init({
      events: [
        ConversationEvent.cases.PromptAccepted.make({ prompt: "ab" }),
        ConversationEvent.cases.TurnEnded.make({ text: "AB", outcome: Outcome.cases.Completed.make({}) }),
        ConversationEvent.cases.PromptAccepted.make({ prompt: "c" }),
        ConversationEvent.cases.TurnEnded.make({ text: "", outcome: Outcome.cases.Cancelled.make({}) }),
      ],
    }).model
    assert.deepStrictEqual(m, {
      messages: [
        { id: 0, role: "user", text: "ab" },
        { id: 1, role: "assistant", text: "AB" },
        { id: 2, role: "user", text: "c" },
        { id: 3, role: "assistant", text: "" },
      ],
      turn: Turn.cases.Idle.make({}),
      nextId: 4,
      notice: Option.none(),
    })
  })

  it("a transcript that ends mid-turn is marked interrupted", () => {
    const m = init({ events: [ConversationEvent.cases.PromptAccepted.make({ prompt: "ab" })] }).model
    assert.strictEqual(m.messages[1]?.text, "[interrupted]")
    assert.deepStrictEqual(m.turn, Turn.cases.Idle.make({}))
  })

  it("a stray TurnEnded is ignored", () => {
    assert.deepStrictEqual(init({ events: [ConversationEvent.cases.TurnEnded.make({ text: "x", outcome: Outcome.cases.Completed.make({}) })] }).model, fresh())
  })
})

it("the model is a fold over the message log", () => {
  const log = [
    Message.cases.SubmittedPrompt.make({ text: "ab" }),
    Message.cases.SucceededAcceptPrompt.make({}),
    Message.cases.ReceivedText.make({ messageId: 1, text: "a" }),
    Message.cases.ReceivedText.make({ messageId: 1, text: "b" }),
    Message.cases.CompletedTurn.make({ messageId: 1 }),
    Message.cases.SucceededCommitTurn.make({ messageId: 1 }),
    Message.cases.SubmittedPrompt.make({ text: "c" }),
    Message.cases.SucceededAcceptPrompt.make({}),
    Message.cases.PressedEscape.make({}),
    Message.cases.SucceededCommitTurn.make({ messageId: 3 }),
  ]
  const replayed = log.reduce((model, message) => update(model, message).model, fresh())
  assert.deepStrictEqual(replayed, {
    messages: [
      { id: 0, role: "user", text: "ab" },
      { id: 1, role: "assistant", text: "ab" },
      { id: 2, role: "user", text: "c" },
      { id: 3, role: "assistant", text: "" },
    ],
    turn: Turn.cases.Idle.make({}),
    nextId: 4,
    notice: Option.none(),
  })
})
