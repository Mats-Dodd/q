import { Schema } from "effect"
import { SessionId } from "./Session.ts"

/**
 * A turn: one activation of the agent, from the user's input through its
 * reasoning, tool calls and output to the reply. A session is a sequence of
 * them. Turn ids are assigned by the server.
 */
export const TurnId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand("TurnId")).annotate({
  identifier: "TurnId"
})
export type TurnId = typeof TurnId.Type

/**
 * Chosen by the client for each message it sends, so a retried request names
 * the same message: sending is idempotent per `MessageId`.
 */
export const MessageId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand("MessageId")).annotate({
  identifier: "MessageId"
})
export type MessageId = typeof MessageId.Type

export const MessageText = Schema.String.check(Schema.isNonEmpty()).annotate({ identifier: "MessageText" })

/** How a turn ended, as clients see it. */
export const TurnEndReason = Schema.Literals(["completed", "cancelled", "failed"]).annotate({
  identifier: "TurnEndReason"
})
export type TurnEndReason = typeof TurnEndReason.Type

/** What sending a message did. (Later: queued behind, or steered, the running turn.) */
export const Delivery = Schema.Struct({
  turnId: TurnId,
  disposition: Schema.Literal("started")
}).annotate({ identifier: "Delivery" })
export type Delivery = typeof Delivery.Type

/** The session is running a turn, so it cannot start another. */
export class SessionBusy extends Schema.TaggedError<SessionBusy>()(
  "SessionBusy",
  { sessionId: SessionId },
  { httpApiStatus: 409 }
) {}

/** No turn is running, so there is nothing to cancel. */
export class NothingToCancel extends Schema.TaggedError<NothingToCancel>()(
  "NothingToCancel",
  { sessionId: SessionId },
  { httpApiStatus: 409 }
) {}
