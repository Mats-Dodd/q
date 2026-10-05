import { describe, it } from "@effect/vitest"
import { assertFailure, assertSuccess, deepStrictEqual, strictEqual } from "@effect/vitest/utils"
import { Option } from "effect"
import { Response } from "effect/ai"
import { SessionId } from "../src/domain/Session.ts"
import type { SessionEvent } from "../src/domain/SessionEvent.ts"
import * as SessionState from "../src/domain/SessionState.ts"
import { MessageId, SessionBusy, TurnId } from "../src/domain/Turn.ts"
import { messageId, turnId, turnStarted } from "./support/Events.ts"

const sessionId = SessionId.make("01a10400-0000-7000-8000-0000000000cc")
const nextTurn = { turnId: TurnId.make("01a10400-0000-7000-8000-0000000000dd"), model: "m" }

const replyParts = (text: string, end = true): SessionEvent => ({
  _tag: "ModelOutput",
  turnId,
  parts: [
    Response.makePart("text-start", { id: "t0" }),
    Response.makePart("text-delta", { id: "t0", delta: text }),
    ...(end ? [Response.makePart("text-end", { id: "t0" })] : [])
  ]
})

const ended = (outcome: Extract<SessionEvent, { _tag: "TurnEnded" }>["outcome"]): SessionEvent => ({
  _tag: "TurnEnded",
  turnId,
  outcome
})

/** The history as (role, text) pairs. */
const conversation = (state: SessionState.SessionState) =>
  state.history.map((message) => [
    message.role,
    typeof message.content === "string"
      ? message.content
      : message.content.map((part) => part.type === "text" ? part.text : "").join("")
  ])

describe("SessionState", () => {
  it("a completed turn adds the user's message and the reply to the history", () => {
    const state = SessionState.replay([
      turnStarted("hi"),
      { _tag: "StepStarted", turnId },
      replyParts("hello"),
      ended({ _tag: "Completed", finishReason: "stop" })
    ])
    strictEqual(state.version, 4)
    deepStrictEqual(conversation(state), [["user", "hi"], ["assistant", "hello"]])
    strictEqual(Option.isNone(state.running), true)
  })

  it("a turn cut short keeps the text it had produced", () => {
    const state = SessionState.replay([turnStarted("hi"), replyParts("hel", false), ended({ _tag: "Cancelled" })])
    deepStrictEqual(conversation(state), [["user", "hi"], ["assistant", "hel"]])
  })

  it("while a turn runs, its output accumulates and its finish reason is known", () => {
    const finish = Response.makePart("finish", {
      reason: "length",
      usage: Response.Usage.make({
        inputTokens: { uncached: 1, total: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined }
      }),
      response: undefined
    })
    const state = SessionState.replay([turnStarted("hi"), replyParts("x"), { _tag: "ModelOutput", turnId, parts: [finish] }])
    const running = Option.getOrThrow(state.running)
    strictEqual(running.parts.length, 4)
    deepStrictEqual(SessionState.lastFinishReason(running), Option.some("length"))
  })

  it("sending a message starts a turn", () => {
    const decision = SessionState.decideSend(SessionState.empty, { sessionId, messageId, text: "hi", ...nextTurn })
    assertSuccess(
      decision,
      SessionState.SendDecision.Start({
        event: { _tag: "TurnStarted", turnId: nextTurn.turnId, messageId, text: "hi", model: "m" }
      })
    )
  })

  it("sending the same message again finds the turn it started", () => {
    const state = SessionState.replay([turnStarted("hi"), ended({ _tag: "Completed", finishReason: "stop" })])
    const decision = SessionState.decideSend(state, { sessionId, messageId, text: "hi", ...nextTurn })
    assertSuccess(decision, SessionState.SendDecision.AlreadyDelivered({ turnId }))
  })

  it("a new message while a turn runs is refused", () => {
    const state = SessionState.replay([turnStarted("hi")])
    const another = MessageId.make("01a10400-0000-7000-8000-0000000000ee")
    const decision = SessionState.decideSend(state, { sessionId, messageId: another, text: "and", ...nextTurn })
    assertFailure(decision, SessionBusy.make({ sessionId }))
  })
})
