import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"
import { SessionId, SessionNotFound } from "../domain/Session.ts"
import { Delivery, MessageId, MessageText, NothingToCancel, SessionBusy } from "../domain/Turn.ts"

const params = { id: SessionId }

/** A user message. `messageId` is chosen by the client, so resending it is safe. */
export const SendMessage = Schema.Struct({ messageId: MessageId, text: MessageText }).annotate({
  identifier: "SendMessage"
})

/**
 * Commands. Their effects are not in the responses: they appear in the
 * session's stream (`SessionStreamApi`), which is where clients watch them.
 */
export class MessagesApi extends HttpApiGroup.make("messages")
  .add(
    /** Sends a message, starting a turn (202: it runs on after the response). */
    HttpApiEndpoint.post("send", "/sessions/:id/messages", {
      params,
      payload: SendMessage,
      success: Delivery.pipe(HttpApiSchema.status(202)),
      error: [SessionNotFound, SessionBusy]
    }),
    /** Cancels the running turn; responds once the cancellation is in the stream. */
    HttpApiEndpoint.post("cancel", "/sessions/:id/cancel", {
      params,
      success: HttpApiSchema.NoContent,
      error: NothingToCancel
    })
  )
{}
