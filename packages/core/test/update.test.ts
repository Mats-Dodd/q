import { assert, describe, it } from "@effect/vitest"
import { Option } from "effect"

import { Program } from "@q/kit"
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
    message(Message.SubmittedPrompt({ text: "hi" })),
    resolve(AcceptPrompt, Message.SucceededAcceptPrompt()),
  ).model

const unchanged = (before: Model, msg: Message) => assert.strictEqual(update(before, msg).model, before)

describe("write-ahead turn", () => {
  it("a prompt is not on screen until the transcript accepts it", () => {
    story(
      update,
      given(fresh()),
      message(Message.SubmittedPrompt({ text: "hello" })),
      model((m) => {
        assert.deepStrictEqual(m.messages, [])
        assert.deepStrictEqual(m.turn, Turn.Accepting({ prompt: "hello" }))
      }),
      expectCommands(AcceptPrompt),
      resolve(AcceptPrompt, Message.SucceededAcceptPrompt()),
      model((m) => {
        assert.deepStrictEqual(m.messages, [
          { id: 0, role: "user", text: "hello" },
          { id: 1, role: "assistant", text: "" },
        ])
        assert.deepStrictEqual(m.turn, Turn.Streaming({ messageId: 1, prompt: "hello" }))
        assert.strictEqual(m.nextId, 2)
      }),
    )
  })

  it("the accept command carries the prompt", () => {
    const [command] = update(fresh(), Message.SubmittedPrompt({ text: "hello" })).commands ?? []
    assert.strictEqual(command?.name, "AcceptPrompt")
    assert.deepStrictEqual(command?.args, { prompt: "hello" })
  })

  it("a rejected prompt leaves no row and shows a notice", () => {
    story(
      update,
      given(fresh()),
      message(Message.SubmittedPrompt({ text: "hello" })),
      resolve(AcceptPrompt, Message.FailedAcceptPrompt({ error: "disk full" })),
      model((m) => {
        assert.deepStrictEqual(m.messages, [])
        assert.deepStrictEqual(m.turn, Turn.Idle())
        assert.deepStrictEqual(m.notice, Option.some("could not save prompt: disk full"))
      }),
      message(Message.SubmittedPrompt({ text: "again" })),
      model((m) => assert.deepStrictEqual(m.notice, Option.none())),
      resolve(AcceptPrompt, Message.SucceededAcceptPrompt()),
    )
  })

  it("completion ends the turn at once and records the full text behind it", () => {
    story(
      update,
      given(streaming()),
      message(Message.ReceivedText({ messageId: 1, text: "he" })),
      message(Message.ReceivedText({ messageId: 1, text: "llo" })),
      message(Message.CompletedTurn({ messageId: 1 })),
      model((m) => {
        assert.strictEqual(m.messages[1]?.text, "hello")
        assert.deepStrictEqual(m.turn, Turn.Idle())
      }),
      expectCommands(CommitTurn),
      resolve(CommitTurn, Message.SucceededCommitTurn({ messageId: 1 })),
      model((m) => assert.deepStrictEqual(m.turn, Turn.Idle())),
    )
  })

  it("a saved turn is a fact the model does not need", () => {
    const idle = update(streaming(), Message.CompletedTurn({ messageId: 1 })).model
    unchanged(idle, Message.SucceededCommitTurn({ messageId: 1 }))
  })

  it("the commit command carries the text and outcome", () => {
    const withText = update(streaming(), Message.ReceivedText({ messageId: 1, text: "partial" })).model
    const [command] = update(withText, Message.PressedEscape()).commands ?? []
    assert.strictEqual(command?.name, "CommitTurn")
    assert.deepStrictEqual(command?.args, { messageId: 1, text: "partial", outcome: Outcome.Cancelled() })
  })

  it("an agent failure records the error on the row and commits a failed outcome", () => {
    const [command] = update(streaming(), Message.FailedTurn({ messageId: 1, error: "offline" })).commands ?? []
    assert.deepStrictEqual(command?.args, { messageId: 1, text: " [error: offline]", outcome: Outcome.Failed({ error: "offline" }) })
  })

  it("a failed commit is a notice; the row stays", () => {
    story(
      update,
      given(streaming()),
      message(Message.CompletedTurn({ messageId: 1 })),
      resolve(CommitTurn, Message.FailedCommitTurn({ messageId: 1, error: "timeout" })),
      model((m) => {
        assert.strictEqual(m.messages.length, 2)
        assert.deepStrictEqual(m.turn, Turn.Idle())
        assert.deepStrictEqual(m.notice, Option.some("could not save turn: timeout"))
      }),
    )
  })

  it("a failed commit landing during the next turn sets the notice and nothing else", () => {
    const next = story(
      update,
      given(streaming()),
      message(Message.CompletedTurn({ messageId: 1 })),
      meanwhile(Message.SubmittedPrompt({ text: "next" })),
      resolve(AcceptPrompt, Message.SucceededAcceptPrompt()),
      resolve(CommitTurn, Message.FailedCommitTurn({ messageId: 1, error: "timeout" })),
    ).model
    assert.deepStrictEqual(next.turn, Turn.Streaming({ messageId: 3, prompt: "next" }))
    assert.strictEqual(next.messages.length, 4)
    assert.deepStrictEqual(next.notice, Option.some("could not save turn: timeout"))
  })

  it("tokens append to the assistant row and leave every other row untouched by reference", () => {
    const before = streaming()
    const after = update(before, Message.ReceivedText({ messageId: 1, text: "h" })).model
    assert.strictEqual(after.messages[1]?.text, "h")
    assert.strictEqual(after.messages[0], before.messages[0]!)
    assert.strictEqual(after.turn, before.turn)
  })
})

describe("messages that do not fit the current state are ignored by reference", () => {
  it("blank prompt, prompt while not idle", () => {
    unchanged(fresh(), Message.SubmittedPrompt({ text: "   " }))
    const accepting = update(fresh(), Message.SubmittedPrompt({ text: "one" })).model
    unchanged(accepting, Message.SubmittedPrompt({ text: "two" }))
    unchanged(streaming(), Message.SubmittedPrompt({ text: "two" }))
  })

  it("escape while idle or accepting", () => {
    unchanged(fresh(), Message.PressedEscape())
    unchanged(update(fresh(), Message.SubmittedPrompt({ text: "one" })).model, Message.PressedEscape())
    unchanged(update(streaming(), Message.CompletedTurn({ messageId: 1 })).model, Message.PressedEscape())
  })

  it("text, completion and failure for a foreign or finished turn", () => {
    const live = streaming()
    unchanged(live, Message.ReceivedText({ messageId: 0, text: "x" }))
    unchanged(live, Message.ReceivedText({ messageId: 99, text: "x" }))
    unchanged(live, Message.CompletedTurn({ messageId: 99 }))
    unchanged(live, Message.FailedTurn({ messageId: 99, error: "x" }))

    const ended = update(live, Message.PressedEscape()).model
    unchanged(ended, Message.ReceivedText({ messageId: 1, text: "late" }))
    unchanged(ended, Message.CompletedTurn({ messageId: 1 }))
    unchanged(ended, Message.FailedTurn({ messageId: 1, error: "late" }))
  })

  it("a stale completion from a cancelled turn cannot end the next turn", () => {
    const second = story(
      update,
      given(streaming()),
      message(Message.PressedEscape()),
      resolve(CommitTurn, Message.SucceededCommitTurn({ messageId: 1 })),
      message(Message.SubmittedPrompt({ text: "next" })),
      resolve(AcceptPrompt, Message.SucceededAcceptPrompt()),
      model((m) => assert.deepStrictEqual(m.turn, Turn.Streaming({ messageId: 3, prompt: "next" }))),
    )
    unchanged(second.model, Message.CompletedTurn({ messageId: 1 }))
    unchanged(second.model, Message.SucceededCommitTurn({ messageId: 1 }))
  })

  it("accept results while idle", () => {
    unchanged(fresh(), Message.SucceededAcceptPrompt())
    unchanged(fresh(), Message.FailedAcceptPrompt({ error: "x" }))
  })
})

describe("init folds the transcript", () => {
  it("completed turns become rows, and the model is idle", () => {
    const m = init({
      events: [
        ConversationEvent.PromptAccepted({ prompt: "ab" }),
        ConversationEvent.TurnEnded({ text: "AB", outcome: Outcome.Completed() }),
        ConversationEvent.PromptAccepted({ prompt: "c" }),
        ConversationEvent.TurnEnded({ text: "", outcome: Outcome.Cancelled() }),
      ],
    }).model
    assert.deepStrictEqual(m, {
      messages: [
        { id: 0, role: "user", text: "ab" },
        { id: 1, role: "assistant", text: "AB" },
        { id: 2, role: "user", text: "c" },
        { id: 3, role: "assistant", text: "" },
      ],
      turn: Turn.Idle(),
      nextId: 4,
      notice: Option.none(),
    })
  })

  it("a transcript that ends mid-turn is marked interrupted", () => {
    const m = init({ events: [ConversationEvent.PromptAccepted({ prompt: "ab" })] }).model
    assert.strictEqual(m.messages[1]?.text, "[interrupted]")
    assert.deepStrictEqual(m.turn, Turn.Idle())
  })

  it("a stray TurnEnded is ignored", () => {
    assert.deepStrictEqual(init({ events: [ConversationEvent.TurnEnded({ text: "x", outcome: Outcome.Completed() })] }).model, fresh())
  })
})

it("the model is a fold over the message log", () => {
  const log = [
    Message.SubmittedPrompt({ text: "ab" }),
    Message.SucceededAcceptPrompt(),
    Message.ReceivedText({ messageId: 1, text: "a" }),
    Message.ReceivedText({ messageId: 1, text: "b" }),
    Message.CompletedTurn({ messageId: 1 }),
    Message.SucceededCommitTurn({ messageId: 1 }),
    Message.SubmittedPrompt({ text: "c" }),
    Message.SucceededAcceptPrompt(),
    Message.PressedEscape(),
    Message.SucceededCommitTurn({ messageId: 3 }),
  ]
  assert.deepStrictEqual(Program.replay(update, fresh(), log), {
    messages: [
      { id: 0, role: "user", text: "ab" },
      { id: 1, role: "assistant", text: "ab" },
      { id: 2, role: "user", text: "c" },
      { id: 3, role: "assistant", text: "" },
    ],
    turn: Turn.Idle(),
    nextId: 4,
    notice: Option.none(),
  })
})
