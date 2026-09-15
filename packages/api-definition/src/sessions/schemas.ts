import { ConversationModelSchema, IntentSchema } from "@q/domain/conversation/model"
import { ResumeSchema, Session, SessionId } from "@q/domain/session/model"
import { Schema } from "effect"
import { HttpApiSchema } from "effect/unstable/httpapi"

export const SessionPath = Schema.Struct({ id: SessionId })

export const ListSessionsQuery = Schema.Struct({ cwd: Schema.String })
export const ListSessionsResponse = Schema.Array(Session.json)

export const OpenSessionPayload = Schema.Struct({ cwd: Schema.String, resume: ResumeSchema })
export const OpenSessionResponse = Session.json

export const SendIntentPayload = IntentSchema

/**
 * A stream of whole Models. Each element replaces the last, so a dropped element is harmless.
 * The stream ends when the turn is `Idle`; a client that wants more sends another request.
 * SSE data is JSON, so the Model gets its JSON codec here (`Option` is not JSON by itself).
 */
export const ConversationModelStream = HttpApiSchema.StreamSse({ data: Schema.toCodecJson(ConversationModelSchema) })
