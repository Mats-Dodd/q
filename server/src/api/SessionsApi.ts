import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { Session, SessionId, SessionNotFound } from "../domain/Session.ts"

const params = { id: SessionId }

// Model variants carry no identifier of their own. Naming them makes them
// shared components in OpenAPI, and named types in generated clients.
const SessionJson = Session.json.annotate({ identifier: "Session" })
const SessionCreate = Session.jsonCreate.annotate({ identifier: "SessionCreate" })
const SessionUpdate = Session.jsonUpdate.annotate({ identifier: "SessionUpdate" })

export class SessionsApi extends HttpApiGroup.make("sessions")
  .add(
    HttpApiEndpoint.post("create", "/sessions", {
      payload: SessionCreate,
      success: SessionJson
    }),
    HttpApiEndpoint.get("list", "/sessions", {
      success: Schema.Array(SessionJson)
    }),
    HttpApiEndpoint.get("get", "/sessions/:id", {
      params,
      success: SessionJson,
      error: SessionNotFound
    }),
    HttpApiEndpoint.patch("update", "/sessions/:id", {
      params,
      payload: SessionUpdate,
      success: SessionJson,
      error: SessionNotFound
    }),
    HttpApiEndpoint.delete("remove", "/sessions/:id", {
      params,
      error: SessionNotFound
    })
  )
{}
