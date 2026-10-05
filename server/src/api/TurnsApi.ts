import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"
import { SessionId, SessionNotFound } from "../domain/Session.ts"
import { MessageText, Turn, TurnId, TurnInProgress, TurnNotRunning } from "../domain/Turn.ts"

const params = { id: SessionId }

const TurnJson = Turn.json.annotate({ identifier: "Turn" })

/** A user message. `turnId` is chosen by the client, so resending it is safe. */
export const StartTurn = Schema.Struct({ turnId: TurnId, text: MessageText }).annotate({ identifier: "StartTurn" })

/**
 * Commands. Their effects are not in the responses: they appear in the
 * session's stream (`SessionStreamApi`), which is where clients watch a turn.
 */
export class TurnsApi extends HttpApiGroup.make("turns")
  .add(
    /** Starts a turn (202: it runs on after the response). */
    HttpApiEndpoint.post("start", "/sessions/:id/turns", {
      params,
      payload: StartTurn,
      success: TurnJson.pipe(HttpApiSchema.status(202)),
      error: [SessionNotFound, TurnInProgress]
    }),
    /** Cancels the running turn; responds once the cancellation is in the stream. */
    HttpApiEndpoint.post("cancel", "/sessions/:id/cancel", {
      params,
      success: HttpApiSchema.NoContent,
      error: TurnNotRunning
    })
  )
{}
