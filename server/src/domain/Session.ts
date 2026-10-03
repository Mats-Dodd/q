import { Schema } from "effect"
import { Model } from "effect/schema"
import { CreatedAt, UpdatedAt } from "./Fields.ts"

export const SessionId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand("SessionId")).annotate({
  identifier: "SessionId"
})
export type SessionId = typeof SessionId.Type

export const SessionTitle = Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(200)).annotate({
  identifier: "SessionTitle"
})

export class Session extends Model.Class<Session>("Session")({
  id: Model.UuidV7Insert(SessionId),
  title: SessionTitle,
  createdAt: CreatedAt,
  updatedAt: UpdatedAt
}) {}

export class SessionNotFound extends Schema.TaggedError<SessionNotFound>()(
  "SessionNotFound",
  { id: SessionId },
  { httpApiStatus: 404 }
) {}
