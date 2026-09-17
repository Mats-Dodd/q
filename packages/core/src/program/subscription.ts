import { TurnSchema } from "@q/domain/conversation/model"
import type { ChatChunk, ConversationModel } from "@q/domain/conversation/model"
import * as Subscription from "@q/kit/subscription"
import { Array, Cause, Effect, Option, Stream } from "effect"

import { AgentService } from "@q/core/agent/agent-service"
import { CurrentSession } from "@q/core/session/current-session"
import { MessageSchema } from "./message"
import type { Message } from "./message"

// SUBSCRIPTION — chunks reach the Model the moment they arrive. Nothing here waits on a clock: a
// delta that came in alone is one message now, not part of a frame later. What arrives together
// (one network read, several deltas) is folded into one message, which costs no time.

/** Two deltas of the same part in the same step, in a row: one delta with the text of both. */
const mergeDeltas = (last: Message, next: Message): Option.Option<Message> => {
  if (last._tag !== "ReceivedChunk" || next._tag !== "ReceivedChunk") {
    return Option.none()
  }
  if (last.messageId !== next.messageId || last.round !== next.round) {
    return Option.none()
  }
  const a = last.chunk
  const b = next.chunk
  if ((a.type !== "text-delta" && a.type !== "reasoning-delta") || b.type !== a.type || a.id !== b.id) {
    return Option.none()
  }
  const chunk: ChatChunk = { ...a, delta: a.delta + b.delta }
  return Option.some(MessageSchema.cases.ReceivedChunk.make({ messageId: last.messageId, round: last.round, chunk }))
}

/** Merge consecutive text or reasoning deltas that arrived together into one. Other messages pass through in order. */
export const coalesce = ([first, ...rest]: Array.NonEmptyReadonlyArray<Message>): Array.NonEmptyArray<Message> => {
  const out: Array.NonEmptyArray<Message> = [first]
  for (const message of rest) {
    const merged = mergeDeltas(Array.lastNonEmpty(out), message)
    if (Option.isSome(merged)) {
      out[out.length - 1] = merged.value
    } else {
      out.push(message)
    }
  }
  return out
}

/**
 * Runs one agent step while `model.turn` is `Streaming`. The deps are the step's identity, so a new
 * round starts a new stream over the messages as they are then, and leaving `Streaming` interrupts
 * the current one; the Model owns the lifetime. Tools work in the session's directory.
 *
 * A step that fails, or dies, ends as `FailedStep`: the turn ends with a notice the user can read. Left
 * to the runtime, a defect would crash it and leave the session `Streaming` forever with nothing on
 * the screen. Interruption is not caught: that is how a round change stops the previous step.
 */
export const AgentTurn = Subscription.make<ConversationModel, Message>()({
  modelToDeps: (model) =>
    TurnSchema.match(model.turn, {
      Idle: () => Option.none(),
      Accepting: () => Option.none(),
      AwaitingApproval: () => Option.none(),
      Streaming: ({ messageId, round }) => Option.some({ messageId, round }),
    }),
  depsToStream: (deps, model) =>
    Option.match(deps, {
      onNone: () => Stream.empty,
      onSome: ({ messageId, round }) =>
        Stream.unwrap(
          Effect.map(Effect.all([AgentService, CurrentSession]), ([agent, session]) =>
            agent.step(model.messages, { cwd: session.cwd }).pipe(
              Stream.map((chunk) => MessageSchema.cases.ReceivedChunk.make({ messageId, round, chunk })),
              Stream.catch((error) => Stream.make(MessageSchema.cases.FailedStep.make({ messageId, round, error: error.message }))),
              Stream.catchDefect((defect) =>
                Stream.make(MessageSchema.cases.FailedStep.make({ messageId, round, error: Cause.pretty(Cause.die(defect)) })),
              ),
              Stream.mapArray(coalesce),
            ),
          ),
        ),
    }),
})
