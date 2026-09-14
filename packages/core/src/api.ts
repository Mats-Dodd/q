import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi"

import { Model } from "./domain/model"
import { Session, SessionId } from "./domain/session"
import { Message } from "./message"
import { Resume } from "./services/transcript"

// API — the contract between a client and the server. Plain HTTP; turns stream back as Server-Sent
// Events. The server owns every session; a client sends intents and watches Models.

/** The Messages a client may send. A subset of `Message`: the rest are facts the server produces. */
export const Intent = Schema.Union([Message.cases.SubmittedPrompt, Message.cases.PressedEscape])
export type Intent = typeof Intent.Type

export class SessionNotFound extends Schema.TaggedError<SessionNotFound>()(
  "SessionNotFound",
  { id: SessionId },
  { httpApiStatus: 404 },
) {}

/** Storage refused. The text is `TranscriptError.message`. */
export class StorageFailed extends Schema.TaggedError<StorageFailed>()(
  "StorageFailed",
  { message: Schema.String },
  { httpApiStatus: 500 },
) {}

/**
 * A stream of whole Models. Each element replaces the last, so a dropped element is harmless.
 * The stream ends when the turn is `Idle`; a client that wants more sends another request.
 * SSE data is JSON, so the Model gets its JSON codec here (`Option` is not JSON by itself).
 */
export const ModelStream = HttpApiSchema.StreamSse({ data: Schema.toCodecJson(Model) })

export class Sessions extends HttpApiGroup.make("sessions")
  .add(
    HttpApiEndpoint.get("list", "/", {
      query: { cwd: Schema.String },
      success: Schema.Array(Session),
      error: StorageFailed,
    }),
    /** Resolve `resume` to a session, creating one when asked. Does not start a runtime. */
    HttpApiEndpoint.post("open", "/", {
      payload: Schema.Struct({ cwd: Schema.String, resume: Resume }),
      success: Session,
      error: [SessionNotFound, StorageFailed],
    }),
    /** Dispatch one intent, then stream the Model until the turn is over. */
    HttpApiEndpoint.post("send", "/:id/send", {
      params: { id: SessionId },
      payload: Intent,
      success: ModelStream,
      error: [SessionNotFound, StorageFailed],
    }),
    /** Stream the current Model, then every change until the turn is over. On an idle session: one Model. */
    HttpApiEndpoint.get("watch", "/:id/watch", {
      params: { id: SessionId },
      success: ModelStream,
      error: [SessionNotFound, StorageFailed],
    }),
  )
  .prefix("/sessions") {}

export class Api extends HttpApi.make("q").add(Sessions) {}
