import { describe, expect, test } from "bun:test"
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

const unchanged = (before: Model, msg: Message) => expect(update(before, msg).model).toBe(before)

describe("write-ahead turn", () => {
  test("a prompt is not on screen until the transcript accepts it", () => {
    story(
      update,
      given(fresh()),
      message(Message.SubmittedPrompt({ text: "hello" })),
      model((m) => {
        expect(m.messages).toEqual([])
        expect(m.turn).toEqual(Turn.Accepting({ prompt: "hello" }))
      }),
      expectCommands(AcceptPrompt),
      resolve(AcceptPrompt, Message.SucceededAcceptPrompt()),
      model((m) => {
        expect(m.messages).toEqual([
          { id: 0, role: "user", text: "hello" },
          { id: 1, role: "assistant", text: "" },
        ])
        expect(m.turn).toEqual(Turn.Streaming({ messageId: 1, prompt: "hello" }))
        expect(m.nextId).toBe(2)
      }),
    )
  })

  test("the accept command carries the prompt", () => {
    const [command] = update(fresh(), Message.SubmittedPrompt({ text: "hello" })).commands ?? []
    expect(command?.name).toBe("AcceptPrompt")
    expect(command?.args).toEqual({ prompt: "hello" })
  })

  test("a rejected prompt leaves no row and shows a notice", () => {
    story(
      update,
      given(fresh()),
      message(Message.SubmittedPrompt({ text: "hello" })),
      resolve(AcceptPrompt, Message.FailedAcceptPrompt({ error: "disk full" })),
      model((m) => {
        expect(m.messages).toEqual([])
        expect(m.turn).toEqual(Turn.Idle())
        expect(m.notice).toEqual(Option.some("could not save prompt: disk full"))
      }),
      message(Message.SubmittedPrompt({ text: "again" })),
      model((m) => expect(m.notice).toEqual(Option.none())),
      resolve(AcceptPrompt, Message.SucceededAcceptPrompt()),
    )
  })

  test("completion ends the turn at once and records the full text behind it", () => {
    story(
      update,
      given(streaming()),
      message(Message.ReceivedText({ messageId: 1, text: "he" })),
      message(Message.ReceivedText({ messageId: 1, text: "llo" })),
      message(Message.CompletedTurn({ messageId: 1 })),
      model((m) => {
        expect(m.messages[1]?.text).toBe("hello")
        expect(m.turn).toEqual(Turn.Idle())
      }),
      expectCommands(CommitTurn),
      resolve(CommitTurn, Message.SucceededCommitTurn({ messageId: 1 })),
      model((m) => expect(m.turn).toEqual(Turn.Idle())),
    )
  })

  test("a saved turn is a fact the model does not need", () => {
    const idle = update(streaming(), Message.CompletedTurn({ messageId: 1 })).model
    unchanged(idle, Message.SucceededCommitTurn({ messageId: 1 }))
  })

  test("the commit command carries the text and outcome", () => {
    const withText = update(streaming(), Message.ReceivedText({ messageId: 1, text: "partial" })).model
    const [command] = update(withText, Message.PressedEscape()).commands ?? []
    expect(command?.name).toBe("CommitTurn")
    expect(command?.args).toEqual({ messageId: 1, text: "partial", outcome: Outcome.Cancelled() })
  })

  test("an agent failure records the error on the row and commits a failed outcome", () => {
    const [command] = update(streaming(), Message.FailedTurn({ messageId: 1, error: "offline" })).commands ?? []
    expect(command?.args).toEqual({ messageId: 1, text: " [error: offline]", outcome: Outcome.Failed({ error: "offline" }) })
  })

  test("a failed commit is a notice; the row stays", () => {
    story(
      update,
      given(streaming()),
      message(Message.CompletedTurn({ messageId: 1 })),
      resolve(CommitTurn, Message.FailedCommitTurn({ messageId: 1, error: "timeout" })),
      model((m) => {
        expect(m.messages).toHaveLength(2)
        expect(m.turn).toEqual(Turn.Idle())
        expect(m.notice).toEqual(Option.some("could not save turn: timeout"))
      }),
    )
  })

  test("a failed commit landing during the next turn sets the notice and nothing else", () => {
    const next = story(
      update,
      given(streaming()),
      message(Message.CompletedTurn({ messageId: 1 })),
      meanwhile(Message.SubmittedPrompt({ text: "next" })),
      resolve(AcceptPrompt, Message.SucceededAcceptPrompt()),
      resolve(CommitTurn, Message.FailedCommitTurn({ messageId: 1, error: "timeout" })),
    ).model
    expect(next.turn).toEqual(Turn.Streaming({ messageId: 3, prompt: "next" }))
    expect(next.messages).toHaveLength(4)
    expect(next.notice).toEqual(Option.some("could not save turn: timeout"))
  })

  test("tokens append to the assistant row and leave every other row untouched by reference", () => {
    const before = streaming()
    const after = update(before, Message.ReceivedText({ messageId: 1, text: "h" })).model
    expect(after.messages[1]?.text).toBe("h")
    expect(after.messages[0]).toBe(before.messages[0]!)
    expect(after.turn).toBe(before.turn)
  })
})

describe("messages that do not fit the current state are ignored by reference", () => {
  test("blank prompt, prompt while not idle", () => {
    unchanged(fresh(), Message.SubmittedPrompt({ text: "   " }))
    const accepting = update(fresh(), Message.SubmittedPrompt({ text: "one" })).model
    unchanged(accepting, Message.SubmittedPrompt({ text: "two" }))
    unchanged(streaming(), Message.SubmittedPrompt({ text: "two" }))
  })

  test("escape while idle or accepting", () => {
    unchanged(fresh(), Message.PressedEscape())
    unchanged(update(fresh(), Message.SubmittedPrompt({ text: "one" })).model, Message.PressedEscape())
    unchanged(update(streaming(), Message.CompletedTurn({ messageId: 1 })).model, Message.PressedEscape())
  })

  test("text, completion and failure for a foreign or finished turn", () => {
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

  test("a stale completion from a cancelled turn cannot end the next turn", () => {
    const second = story(
      update,
      given(streaming()),
      message(Message.PressedEscape()),
      resolve(CommitTurn, Message.SucceededCommitTurn({ messageId: 1 })),
      message(Message.SubmittedPrompt({ text: "next" })),
      resolve(AcceptPrompt, Message.SucceededAcceptPrompt()),
      model((m) => expect(m.turn).toEqual(Turn.Streaming({ messageId: 3, prompt: "next" }))),
    )
    unchanged(second.model, Message.CompletedTurn({ messageId: 1 }))
    unchanged(second.model, Message.SucceededCommitTurn({ messageId: 1 }))
  })

  test("accept results while idle", () => {
    unchanged(fresh(), Message.SucceededAcceptPrompt())
    unchanged(fresh(), Message.FailedAcceptPrompt({ error: "x" }))
  })
})

describe("init folds the transcript", () => {
  test("completed turns become rows, and the model is idle", () => {
    const m = init({
      events: [
        ConversationEvent.PromptAccepted({ prompt: "ab" }),
        ConversationEvent.TurnEnded({ text: "AB", outcome: Outcome.Completed() }),
        ConversationEvent.PromptAccepted({ prompt: "c" }),
        ConversationEvent.TurnEnded({ text: "", outcome: Outcome.Cancelled() }),
      ],
    }).model
    expect(m).toEqual({
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

  test("a transcript that ends mid-turn is marked interrupted", () => {
    const m = init({ events: [ConversationEvent.PromptAccepted({ prompt: "ab" })] }).model
    expect(m.messages[1]?.text).toBe("[interrupted]")
    expect(m.turn).toEqual(Turn.Idle())
  })

  test("a stray TurnEnded is ignored", () => {
    expect(init({ events: [ConversationEvent.TurnEnded({ text: "x", outcome: Outcome.Completed() })] }).model).toEqual(fresh())
  })
})

test("the model is a fold over the message log", () => {
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
  expect(Program.replay(update, fresh(), log)).toEqual({
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
