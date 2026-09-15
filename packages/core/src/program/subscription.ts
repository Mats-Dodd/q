import { type ConversationModel, TurnSchema } from "@q/domain/conversation/model"
import * as Subscription from "@q/kit/subscription"
import { Effect, Option, Stream } from "effect"

import { AgentService } from "../agent/agent-service"
import { type Message, MessageSchema } from "./message"

// SUBSCRIPTION

/** One terminal frame at OpenTUI's default 30fps. Delivering faster than this is coalesced by the renderer anyway. */
export const BATCH_WINDOW = "33 millis"
/** Bounds the size of one update when a source is faster than the window. */
export const BATCH_SIZE = 64

/** Merge consecutive `ReceivedText` messages in one batch into one. Other messages pass through in order. */
export const coalesce = (batch: ReadonlyArray<Message>): ReadonlyArray<Message> =>
  batch.reduce<Array<Message>>((out, message) => {
    const last = out.at(-1)
    if (message._tag === "ReceivedText" && last?._tag === "ReceivedText" && last.messageId === message.messageId) {
      out[out.length - 1] = MessageSchema.cases.ReceivedText.make({ messageId: last.messageId, text: last.text + message.text })
    } else {
      out.push(message)
    }
    return out
  }, [])

/**
 * Runs while `model.turn` is `Streaming`. Leaving that state changes the deps and the runtime
 * interrupts the stream; the Model owns the lifetime. Transport chunks are batched to one
 * message per frame, and the terminal message flushes with any pending text.
 */
export const AgentTurn = Subscription.make<ConversationModel, Message>()({
  modelToDeps: (model) =>
    TurnSchema.match(model.turn, {
      Idle: () => Option.none(),
      Accepting: () => Option.none(),
      Streaming: ({ messageId, prompt }) => Option.some({ messageId, prompt }),
    }),
  depsToStream: Option.match({
    onNone: () => Stream.empty,
    onSome: ({ messageId, prompt }) =>
      Stream.unwrap(
        Effect.map(AgentService, (agent) =>
          agent.stream(prompt).pipe(
            Stream.map((text) => MessageSchema.cases.ReceivedText.make({ messageId, text })),
            Stream.concat(Stream.make(MessageSchema.cases.CompletedTurn.make({ messageId }))),
            Stream.catch((error) => Stream.make(MessageSchema.cases.FailedTurn.make({ messageId, error: error.message }))),
            Stream.groupedWithin(BATCH_SIZE, BATCH_WINDOW),
            Stream.flatMap((batch) => Stream.fromIterable(coalesce(batch))),
          ),
        ),
      ),
  }),
})
