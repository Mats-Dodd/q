import type { ConversationModel, Intent } from "@q/domain/conversation/model"
import * as Command from "@q/kit/command"
import { Effect, Stream } from "effect"

import { Transport } from "../transport/transport-service"
import { type Message, MessageSchema } from "./message"

// COMMANDS — every request streams whole Models back; each one replaces the mirror.

const asMessages = (models: Stream.Stream<ConversationModel, { readonly message: string }>): Stream.Stream<Message> =>
  models.pipe(
    Stream.map((model) => MessageSchema.cases.ReceivedModel.make({ model })),
    Stream.concat(Stream.make(MessageSchema.cases.CompletedRequest.make({}))),
    Stream.catch((error) => Stream.make(MessageSchema.cases.FailedRequest.make({ error: error.message }))),
  )

/** Dispatch one intent on the server and mirror the Models it streams back. */
export const Send = Command.defineStream("Send", ({ intent }: { intent: Intent }) =>
  Stream.unwrap(Effect.map(Transport, (transport) => asMessages(transport.send(intent)))),
)

/** Mirror the server's current Model and follow the running turn, if any. */
export const Watch = Command.defineStream("Watch", (_: {}) =>
  Stream.unwrap(Effect.map(Transport, (transport) => asMessages(transport.watch))),
)
