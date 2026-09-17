import { assert, describe, it } from "@effect/vitest"
import type { AgentTools } from "@q/domain/agent/tools"
import { TurnSchema } from "@q/domain/conversation/model"
import type { ChatChunk, ChatMessagePart, ConversationModel } from "@q/domain/conversation/model"
import { ConversationEventSchema, OutcomeSchema } from "@q/domain/transcript/model"
import { makeDeniedChunk, makeBashApprovalChunks, makeBashOutputChunk, makeReadCallChunks, makeTextChunks } from "@q/factories/chat-chunk"
import { makeStepEnded, makeTurnEnded } from "@q/factories/conversation-event"
import { makeAssistantMessage, makeTextStep, makeUserMessage } from "@q/factories/conversation-model"
import { expectCommands, given, meanwhile, message, model, resolve, story } from "@q/kit/story"
import type { Step } from "@q/kit/story"
import { Option } from "effect"
import { isToolUIPart } from "effect-ai-ui/UIMessage"
import type { AnyToolUIPart } from "effect-ai-ui/UIMessage"

import type { CurrentSession } from "@q/core/session/current-session"
import type { TranscriptService } from "@q/core/transcript/transcript-service"
import { AcceptPrompt, CommitStep, CommitTurn } from "./command"
import { MessageSchema } from "./message"
import type { Message } from "./message"
import { init, update } from "./update"

const fresh = () => init({ events: [] }).model

/** Drive a fresh model to `Streaming` on the prompt "hi": messages "0" (user) and "1" (assistant), round 0. */
const streaming = (): ConversationModel =>
  story(
    update,
    given(fresh()),
    message(MessageSchema.cases.SubmittedPrompt.make({ text: "hi" })),
    resolve(AcceptPrompt, MessageSchema.cases.SucceededAcceptPrompt.make({})),
  ).model

const assertUnchanged = (before: ConversationModel, msg: Message) => assert.strictEqual(update(before, msg).model, before)

type StoryStep = Step<ConversationModel, Message, CurrentSession | TranscriptService>

const chunk = (chunk: ChatChunk, round = 0, messageId = "1") => MessageSchema.cases.ReceivedChunk.make({ messageId, round, chunk })
const chunks = (all: ReadonlyArray<ChatChunk>, round = 0): ReadonlyArray<StoryStep> => all.map((c) => message(chunk(c, round)))
const startStep = (round = 0) => chunk({ type: "start-step" }, round)
const finishStep = (round = 0) => chunk({ type: "finish-step" }, round)

/** Feed `model` one whole step. */
const step = (model: ConversationModel, all: ReadonlyArray<ChatChunk>, round = 0): ConversationModel =>
  [startStep(round), ...all.map((c) => chunk(c, round)), finishStep(round)].reduce((m, msg) => update(m, msg).model, model)

/** The story steps of one whole step of text, leaving its `CommitTurn` pending. */
const textStep = (text: string, round = 0): ReadonlyArray<StoryStep> => [
  message(startStep(round)),
  ...chunks(makeTextChunks(text), round),
  message(finishStep(round)),
]

const assistantParts = (m: ConversationModel): ReadonlyArray<ChatMessagePart> => m.messages[1]?.parts ?? []
const assistantText = (m: ConversationModel): string =>
  assistantParts(m)
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("")

/** The part at `index` of the assistant message, which must be a tool part. */
const toolAt = (m: ConversationModel, index: number): AnyToolUIPart<AgentTools> => {
  const part = assistantParts(m)[index]
  if (part === undefined || !isToolUIPart(part)) {
    throw new Error(`no tool part at ${index}`)
  }
  return part
}

const streamingAt = (round: number) => TurnSchema.cases.Streaming.make({ messageId: "1", round })

describe("write-ahead turn", () => {
  it("a prompt is not on screen until the transcript accepts it", () => {
    story(
      update,
      given(fresh()),
      message(MessageSchema.cases.SubmittedPrompt.make({ text: "hello" })),
      model((m) => {
        assert.deepStrictEqual(m.messages, [])
        assert.deepStrictEqual(m.turn, TurnSchema.cases.Accepting.make({ prompt: "hello" }))
      }),
      expectCommands(AcceptPrompt),
      resolve(AcceptPrompt, MessageSchema.cases.SucceededAcceptPrompt.make({})),
      model((m) => {
        assert.deepStrictEqual(m.messages, [makeUserMessage("0", "hello"), makeAssistantMessage("1", [])])
        assert.deepStrictEqual(m.turn, streamingAt(0))
        assert.strictEqual(m.nextId, 2)
      }),
    )
  })

  it("the accept command carries the prompt", () => {
    const [command] = update(fresh(), MessageSchema.cases.SubmittedPrompt.make({ text: "hello" })).commands ?? []
    assert.strictEqual(command?.name, "AcceptPrompt")
    assert.deepStrictEqual(command?.args, { prompt: "hello" })
  })

  it("a rejected prompt leaves no message and shows a notice", () => {
    story(
      update,
      given(fresh()),
      message(MessageSchema.cases.SubmittedPrompt.make({ text: "hello" })),
      resolve(AcceptPrompt, MessageSchema.cases.FailedAcceptPrompt.make({ error: "disk full" })),
      model((m) => {
        assert.deepStrictEqual(m.messages, [])
        assert.deepStrictEqual(m.turn, TurnSchema.cases.Idle.make({}))
        assert.deepStrictEqual(m.notice, Option.some("could not save prompt: disk full"))
      }),
      message(MessageSchema.cases.SubmittedPrompt.make({ text: "again" })),
      model((m) => assert.deepStrictEqual(m.notice, Option.none())),
      resolve(AcceptPrompt, MessageSchema.cases.SucceededAcceptPrompt.make({})),
    )
  })
})

describe("a step of text ends the turn", () => {
  it("chunks fold into parts; finish-step commits the whole message", () => {
    story(
      update,
      given(streaming()),
      message(startStep()),
      ...chunks([
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "he" },
      ]),
      model((m) =>
        assert.deepStrictEqual(assistantParts(m), [{ type: "step-start" }, { type: "text", id: "t", text: "he", state: "streaming" }]),
      ),
      ...chunks([
        { type: "text-delta", id: "t", delta: "llo" },
        { type: "text-end", id: "t" },
      ]),
      message(finishStep()),
      model((m) => {
        assert.deepStrictEqual(assistantParts(m), [{ type: "step-start" }, { type: "text", id: "t", text: "hello", state: "done" }])
        assert.deepStrictEqual(m.turn, TurnSchema.cases.Idle.make({}))
      }),
      expectCommands(CommitTurn),
      resolve(CommitTurn, MessageSchema.cases.SucceededCommitTurn.make({ messageId: "1" })),
      model((m) => assert.deepStrictEqual(m.turn, TurnSchema.cases.Idle.make({}))),
    )
  })

  it("the commit command carries the finalized parts and the outcome", () => {
    const [command] =
      update(step(streaming(), makeTextChunks("hello")), MessageSchema.cases.SucceededCommitTurn.make({ messageId: "1" })).commands ?? []
    assert.isUndefined(command)
    const mid = [startStep(), chunk({ type: "text-start", id: "t" }), chunk({ type: "text-delta", id: "t", delta: "partial" })].reduce(
      (m, msg) => update(m, msg).model,
      streaming(),
    )
    const [cancel] = update(mid, MessageSchema.cases.PressedEscape.make({})).commands ?? []
    assert.strictEqual(cancel?.name, "CommitTurn")
    assert.deepStrictEqual(cancel?.args, {
      messageId: "1",
      parts: [{ type: "step-start" }, { type: "text", id: "t", text: "partial", state: "done" }],
      outcome: OutcomeSchema.cases.Cancelled.make({}),
    })
  })

  it("a saved turn is a fact the model does not need", () => {
    const idle = step(streaming(), makeTextChunks("x"))
    assertUnchanged(idle, MessageSchema.cases.SucceededCommitTurn.make({ messageId: "1" }))
  })

  it("a failed commit is a notice; the message stays", () => {
    story(
      update,
      given(streaming()),
      ...textStep("x"),
      resolve(CommitTurn, MessageSchema.cases.FailedCommitTurn.make({ messageId: "1", error: "timeout" })),
      model((m) => {
        assert.strictEqual(m.messages.length, 2)
        assert.deepStrictEqual(m.turn, TurnSchema.cases.Idle.make({}))
        assert.deepStrictEqual(m.notice, Option.some("could not save turn: timeout"))
      }),
    )
  })

  it("a failed commit landing during the next turn sets the notice and nothing else", () => {
    const next = story(
      update,
      given(streaming()),
      ...textStep("x"),
      meanwhile(MessageSchema.cases.SubmittedPrompt.make({ text: "next" })),
      resolve(AcceptPrompt, MessageSchema.cases.SucceededAcceptPrompt.make({})),
      resolve(CommitTurn, MessageSchema.cases.FailedCommitTurn.make({ messageId: "1", error: "timeout" })),
    ).model
    assert.deepStrictEqual(next.turn, TurnSchema.cases.Streaming.make({ messageId: "3", round: 0 }))
    assert.strictEqual(next.messages.length, 4)
    assert.deepStrictEqual(next.notice, Option.some("could not save turn: timeout"))
  })

  it("chunks touch the assistant message and leave every other message untouched by reference", () => {
    const before = streaming()
    const after = update(before, startStep()).model
    assert.deepStrictEqual(assistantParts(after), [{ type: "step-start" }])
    assert.strictEqual(after.messages[0], before.messages[0])
    assert.strictEqual(after.turn, before.turn)
  })
})

describe("the loop", () => {
  it("a step whose tool calls all have results continues with the next round and records the step", () => {
    story(
      update,
      given(streaming()),
      message(startStep()),
      ...chunks(makeReadCallChunks("call-1", "README.md")),
      message(finishStep()),
      model((m) => {
        assert.deepStrictEqual(m.turn, streamingAt(1))
        assert.strictEqual(assistantParts(m).length, 2)
      }),
      expectCommands(CommitStep),
      resolve(CommitStep, MessageSchema.cases.SucceededCommitStep.make({ messageId: "1", round: 0 })),
      // Round 1: the model answers with text. The turn ends.
      message(startStep(1)),
      ...chunks(makeTextChunks("A README."), 1),
      message(finishStep(1)),
      model((m) => {
        assert.deepStrictEqual(m.turn, TurnSchema.cases.Idle.make({}))
        assert.strictEqual(assistantText(m), "A README.")
        assert.deepStrictEqual(
          assistantParts(m).map((p) => p.type),
          ["step-start", "tool-read", "step-start", "text"],
        )
      }),
      expectCommands(CommitTurn),
      resolve(CommitTurn, MessageSchema.cases.SucceededCommitTurn.make({ messageId: "1" })),
    )
  })

  it("the step commit carries the whole message so far", () => {
    const mid = [startStep(), ...makeReadCallChunks("call-1", "README.md").map((c) => chunk(c))].reduce(
      (m, msg) => update(m, msg).model,
      streaming(),
    )
    const [command] = update(mid, finishStep()).commands ?? []
    assert.strictEqual(command?.name, "CommitStep")
    assert.deepStrictEqual(command?.args, { messageId: "1", round: 0, parts: assistantParts(mid) })
  })

  it("a chunk for the previous round is late and ignored", () => {
    const second = step(streaming(), makeReadCallChunks("call-1", "README.md"))
    assert.deepStrictEqual(second.turn, streamingAt(1))
    assertUnchanged(second, chunk({ type: "text-start", id: "late" }, 0))
    assertUnchanged(second, finishStep(0))
  })

  it("a tool call left without a result ends the turn rather than asking the model about it", () => {
    const m = step(streaming(), [
      { type: "tool-input-start", toolCallId: "call-1", toolName: "read" },
      { type: "tool-input-available", toolCallId: "call-1", toolName: "read", input: { path: "README.md" } },
    ])
    assert.deepStrictEqual(m.turn, TurnSchema.cases.Idle.make({}))
  })

  it("a failed tool result is still a result: the model gets to see it", () => {
    const m = step(streaming(), [
      { type: "tool-input-start", toolCallId: "call-1", toolName: "read" },
      { type: "tool-input-available", toolCallId: "call-1", toolName: "read", input: { path: "missing.md" } },
      { type: "tool-output-error", toolCallId: "call-1", errorText: "not-found" },
    ])
    assert.deepStrictEqual(m.turn, streamingAt(1))
  })

  it("an agent error ends the turn as failed and says so", () => {
    story(
      update,
      given(streaming()),
      message(startStep()),
      ...chunks([
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "o" },
      ]),
      message(chunk({ type: "error", errorText: "offline" })),
      model((m) => {
        assert.deepStrictEqual(m.turn, TurnSchema.cases.Idle.make({}))
        assert.deepStrictEqual(m.notice, Option.some("agent failed: offline"))
        assert.deepStrictEqual(assistantParts(m), [{ type: "step-start" }, { type: "text", id: "t", text: "o", state: "done" }])
      }),
      expectCommands(CommitTurn),
      resolve(CommitTurn, MessageSchema.cases.SucceededCommitTurn.make({ messageId: "1" })),
    )
    const [command] =
      update(streaming(), MessageSchema.cases.FailedStep.make({ messageId: "1", round: 0, error: "offline" })).commands ?? []
    assert.deepStrictEqual(command?.args, { messageId: "1", parts: [], outcome: OutcomeSchema.cases.Failed.make({ error: "offline" }) })
  })

  it("a chunk that does not fit the message ends the turn as failed", () => {
    const m = update(streaming(), chunk({ type: "text-delta", id: "nobody", delta: "x" })).model
    assert.deepStrictEqual(m.turn, TurnSchema.cases.Idle.make({}))
    assert.isTrue(Option.exists(m.notice, (n) => n.startsWith("agent failed: ")))
  })
})

describe("approvals", () => {
  const parked = (): ConversationModel => step(streaming(), makeBashApprovalChunks("call-1", "approval-1"))

  it("an approval request parks the turn and records the step", () => {
    story(
      update,
      given(streaming()),
      message(startStep()),
      ...chunks(makeBashApprovalChunks("call-1", "approval-1")),
      message(finishStep()),
      model((m) => assert.deepStrictEqual(m.turn, TurnSchema.cases.AwaitingApproval.make({ messageId: "1", round: 0 }))),
      expectCommands(CommitStep),
      resolve(CommitStep, MessageSchema.cases.SucceededCommitStep.make({ messageId: "1", round: 0 })),
    )
  })

  it("the user's answer goes on the part, and the next round carries it to the model", () => {
    story(
      update,
      given(parked()),
      message(MessageSchema.cases.RespondedToolApproval.make({ toolCallId: "call-1", approved: true })),
      model((m) => {
        assert.deepStrictEqual(m.turn, streamingAt(1))
        const part = toolAt(m, 1)
        assert.strictEqual(part.type, "tool-bash")
        assert.strictEqual(part.state, "approval-responded")
        assert.deepStrictEqual(part.state === "approval-responded" ? part.approval : undefined, { id: "approval-1", approved: true })
      }),
      expectCommands(),
      // Round 1: the pre-resolved result lands on the part from round 0, then the model answers.
      message(startStep(1)),
      message(chunk(makeBashOutputChunk("call-1"), 1)),
      ...chunks(makeTextChunks("Done."), 1),
      message(finishStep(1)),
      model((m) => {
        assert.deepStrictEqual(m.turn, TurnSchema.cases.Idle.make({}))
        const part = toolAt(m, 1)
        assert.strictEqual(part.type, "tool-bash")
        assert.strictEqual(part.state, "output-available")
      }),
      expectCommands(CommitTurn),
      resolve(CommitTurn, MessageSchema.cases.SucceededCommitTurn.make({ messageId: "1" })),
    )
  })

  it("a denial is an answer too; the next round ends the call as denied", () => {
    const denied = update(parked(), MessageSchema.cases.RespondedToolApproval.make({ toolCallId: "call-1", approved: false })).model
    assert.deepStrictEqual(denied.turn, streamingAt(1))
    const after = step(denied, [makeDeniedChunk("call-1"), ...makeTextChunks("Not run.")], 1)
    assert.deepStrictEqual(after.turn, TurnSchema.cases.Idle.make({}))
    assert.strictEqual(toolAt(after, 1).state, "output-denied")
  })

  it("two requests: the turn waits for both answers", () => {
    const both = step(streaming(), [...makeBashApprovalChunks("call-1", "approval-1"), ...makeBashApprovalChunks("call-2", "approval-2")])
    const one = update(both, MessageSchema.cases.RespondedToolApproval.make({ toolCallId: "call-1", approved: true })).model
    assert.deepStrictEqual(one.turn, TurnSchema.cases.AwaitingApproval.make({ messageId: "1", round: 0 }))
    const two = update(one, MessageSchema.cases.RespondedToolApproval.make({ toolCallId: "call-2", approved: false })).model
    assert.deepStrictEqual(two.turn, streamingAt(1))
  })

  it("escape while parked cancels the turn; the request is left as it was", () => {
    const [command] = update(parked(), MessageSchema.cases.PressedEscape.make({})).commands ?? []
    assert.strictEqual(command?.name, "CommitTurn")
    assert.deepStrictEqual(command?.args?.outcome, OutcomeSchema.cases.Cancelled.make({}))
  })

  it("answers that fit nothing are ignored by reference", () => {
    assertUnchanged(parked(), MessageSchema.cases.RespondedToolApproval.make({ toolCallId: "call-99", approved: true }))
    assertUnchanged(streaming(), MessageSchema.cases.RespondedToolApproval.make({ toolCallId: "call-1", approved: true }))
    assertUnchanged(fresh(), MessageSchema.cases.RespondedToolApproval.make({ toolCallId: "call-1", approved: true }))
    const answered = update(parked(), MessageSchema.cases.RespondedToolApproval.make({ toolCallId: "call-1", approved: true })).model
    assertUnchanged(answered, MessageSchema.cases.RespondedToolApproval.make({ toolCallId: "call-1", approved: true }))
  })
})

describe("messages that do not fit the current state are ignored by reference", () => {
  it("blank prompt, prompt while not idle", () => {
    assertUnchanged(fresh(), MessageSchema.cases.SubmittedPrompt.make({ text: "   " }))
    const accepting = update(fresh(), MessageSchema.cases.SubmittedPrompt.make({ text: "one" })).model
    assertUnchanged(accepting, MessageSchema.cases.SubmittedPrompt.make({ text: "two" }))
    assertUnchanged(streaming(), MessageSchema.cases.SubmittedPrompt.make({ text: "two" }))
  })

  it("escape while idle or accepting", () => {
    assertUnchanged(fresh(), MessageSchema.cases.PressedEscape.make({}))
    assertUnchanged(
      update(fresh(), MessageSchema.cases.SubmittedPrompt.make({ text: "one" })).model,
      MessageSchema.cases.PressedEscape.make({}),
    )
    assertUnchanged(step(streaming(), makeTextChunks("x")), MessageSchema.cases.PressedEscape.make({}))
  })

  it("chunks and failures for a foreign or finished step", () => {
    const live = streaming()
    assertUnchanged(live, chunk({ type: "start-step" }, 0, "0"))
    assertUnchanged(live, chunk({ type: "start-step" }, 0, "99"))
    assertUnchanged(live, chunk({ type: "start-step" }, 1))
    assertUnchanged(live, MessageSchema.cases.FailedStep.make({ messageId: "99", round: 0, error: "x" }))

    const ended = update(live, MessageSchema.cases.PressedEscape.make({})).model
    assertUnchanged(ended, chunk({ type: "start-step" }))
    assertUnchanged(ended, finishStep())
    assertUnchanged(ended, MessageSchema.cases.FailedStep.make({ messageId: "1", round: 0, error: "late" }))
  })

  it("a stale finish from a cancelled turn cannot end the next turn", () => {
    const second = story(
      update,
      given(streaming()),
      message(MessageSchema.cases.PressedEscape.make({})),
      resolve(CommitTurn, MessageSchema.cases.SucceededCommitTurn.make({ messageId: "1" })),
      message(MessageSchema.cases.SubmittedPrompt.make({ text: "next" })),
      resolve(AcceptPrompt, MessageSchema.cases.SucceededAcceptPrompt.make({})),
      model((m) => assert.deepStrictEqual(m.turn, TurnSchema.cases.Streaming.make({ messageId: "3", round: 0 }))),
    )
    assertUnchanged(second.model, finishStep())
    assertUnchanged(second.model, MessageSchema.cases.SucceededCommitTurn.make({ messageId: "1" }))
  })

  it("accept results while idle", () => {
    assertUnchanged(fresh(), MessageSchema.cases.SucceededAcceptPrompt.make({}))
    assertUnchanged(fresh(), MessageSchema.cases.FailedAcceptPrompt.make({ error: "x" }))
  })
})

describe("init folds the transcript", () => {
  it("completed turns become messages, and the model is idle", () => {
    const m = init({
      events: [
        ConversationEventSchema.cases.PromptAccepted.make({ prompt: "ab" }),
        makeTurnEnded("AB"),
        ConversationEventSchema.cases.PromptAccepted.make({ prompt: "c" }),
        makeTurnEnded([], OutcomeSchema.cases.Cancelled.make({})),
      ],
    }).model
    assert.deepStrictEqual(m, {
      messages: [
        makeUserMessage("0", "ab"),
        makeAssistantMessage("1", makeTextStep("AB")),
        makeUserMessage("2", "c"),
        makeAssistantMessage("3", []),
      ],
      turn: TurnSchema.cases.Idle.make({}),
      nextId: 4,
      notice: Option.none(),
    })
  })

  it("the last snapshot wins: a step's record is replaced by the turn's", () => {
    const read = step(streaming(), makeReadCallChunks("call-1", "README.md"))
    const done = step(read, makeTextChunks("clear"), 1)
    const m = init({
      events: [
        ConversationEventSchema.cases.PromptAccepted.make({ prompt: "hi" }),
        makeStepEnded(assistantParts(read)),
        makeTurnEnded(assistantParts(done)),
      ],
    }).model
    assert.deepStrictEqual(m, done)
  })

  it("a transcript that ends mid-step is interrupted: parts are closed, the turn is idle, and there is a notice", () => {
    const m = init({
      events: [
        ConversationEventSchema.cases.PromptAccepted.make({ prompt: "ab" }),
        makeStepEnded([{ type: "step-start" }, { type: "text", id: "t", text: "half", state: "streaming" }]),
      ],
    }).model
    assert.deepStrictEqual(assistantParts(m), [{ type: "step-start" }, { type: "text", id: "t", text: "half", state: "done" }])
    assert.deepStrictEqual(m.turn, TurnSchema.cases.Idle.make({}))
    assert.deepStrictEqual(m.notice, Option.some("the last turn was interrupted"))
    assert.deepStrictEqual(
      init({ events: [ConversationEventSchema.cases.PromptAccepted.make({ prompt: "ab" })] }).model.turn,
      TurnSchema.cases.Idle.make({}),
    )
  })

  it("a turn parked for approval survives a restart", () => {
    const parked = step(streaming(), makeBashApprovalChunks("call-1", "approval-1"))
    const m = init({
      events: [ConversationEventSchema.cases.PromptAccepted.make({ prompt: "hi" }), makeStepEnded(assistantParts(parked))],
    }).model
    assert.deepStrictEqual(m, parked)
  })

  it("stray step and turn records are ignored", () => {
    assert.deepStrictEqual(init({ events: [makeTurnEnded("x")] }).model, fresh())
    assert.deepStrictEqual(init({ events: [makeStepEnded(makeTextStep("x"))] }).model, fresh())
  })
})

it("the model is a fold over the message log", () => {
  const log = [
    MessageSchema.cases.SubmittedPrompt.make({ text: "ab" }),
    MessageSchema.cases.SucceededAcceptPrompt.make({}),
    startStep(),
    ...makeTextChunks("ab", "t").map((c) => chunk(c)),
    finishStep(),
    MessageSchema.cases.SucceededCommitTurn.make({ messageId: "1" }),
    MessageSchema.cases.SubmittedPrompt.make({ text: "c" }),
    MessageSchema.cases.SucceededAcceptPrompt.make({}),
    MessageSchema.cases.PressedEscape.make({}),
    MessageSchema.cases.SucceededCommitTurn.make({ messageId: "3" }),
  ]
  const replayed = log.reduce((model, message) => update(model, message).model, fresh())
  assert.deepStrictEqual(replayed, {
    messages: [
      makeUserMessage("0", "ab"),
      makeAssistantMessage("1", [{ type: "step-start" }, { type: "text", id: "t", text: "ab", state: "done" }]),
      makeUserMessage("2", "c"),
      makeAssistantMessage("3", []),
    ],
    turn: TurnSchema.cases.Idle.make({}),
    nextId: 4,
    notice: Option.none(),
  })
})
