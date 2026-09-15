import { PersistenceError } from "@q/domain/persistence-error"
import { SessionNotFoundError } from "@q/domain/session/errors"
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"

import {
  ConversationModelStream,
  ListSessionsQuery,
  ListSessionsResponse,
  OpenSessionPayload,
  OpenSessionResponse,
  SendIntentPayload,
  SessionPath,
} from "./schemas"

// The server owns every session; a client sends intents and watches Models. Turns stream back as Server-Sent Events.

export const SessionsGroup = HttpApiGroup.make("sessions")
  .add(
    HttpApiEndpoint.get("listSessions", "/", {
      query: ListSessionsQuery,
      success: ListSessionsResponse,
      error: PersistenceError,
    }),
    /** Resolve `resume` to a session, creating one when asked. Does not start a runtime. */
    HttpApiEndpoint.post("openSession", "/", {
      payload: OpenSessionPayload,
      success: OpenSessionResponse,
      error: [SessionNotFoundError, PersistenceError],
    }),
    /** Dispatch one intent, then stream the Model until the conversation waits on the user. */
    HttpApiEndpoint.post("sendIntent", "/:id/send", {
      params: SessionPath,
      payload: SendIntentPayload,
      success: ConversationModelStream,
      error: [SessionNotFoundError, PersistenceError],
    }),
    /** Stream the current Model, then every change until the conversation waits on the user. On an idle session: one Model. */
    HttpApiEndpoint.get("watchSession", "/:id/watch", {
      params: SessionPath,
      success: ConversationModelStream,
      error: [SessionNotFoundError, PersistenceError],
    }),
  )
  .prefix("/sessions")
