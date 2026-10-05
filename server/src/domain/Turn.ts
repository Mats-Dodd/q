import { Schema } from "effect"
import { Model } from "effect/schema"
import { CreatedAt, UpdatedAt } from "./Fields.ts"
import { SessionId } from "./Session.ts"

/**
 * Chosen by the client when it sends a message, so a retried request names the
 * same turn: sending is idempotent per `TurnId`.
 */
export const TurnId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand("TurnId")).annotate({
  identifier: "TurnId"
})
export type TurnId = typeof TurnId.Type

/** How a turn ended. */
export const TurnEndReason = Schema.Literals(["completed", "cancelled", "failed"]).annotate({
  identifier: "TurnEndReason"
})
export type TurnEndReason = typeof TurnEndReason.Type

export const TurnStatus = Schema.Literals(["running", ...TurnEndReason.literals]).annotate({ identifier: "TurnStatus" })
export type TurnStatus = typeof TurnStatus.Type

/** One user message and the agent's response to it. */
export class Turn extends Model.Class<Turn>("Turn")({
  id: TurnId,
  sessionId: SessionId,
  status: TurnStatus,
  createdAt: CreatedAt,
  updatedAt: UpdatedAt
}) {}

export const MessageText = Schema.String.check(Schema.isNonEmpty()).annotate({ identifier: "MessageText" })

export class TurnInProgress extends Schema.TaggedError<TurnInProgress>()(
  "TurnInProgress",
  { sessionId: SessionId },
  { httpApiStatus: 409 }
) {}

export class TurnNotRunning extends Schema.TaggedError<TurnNotRunning>()(
  "TurnNotRunning",
  { sessionId: SessionId },
  { httpApiStatus: 409 }
) {}
