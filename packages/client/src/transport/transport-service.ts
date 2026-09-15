import type { ConversationModel, Intent } from "@q/domain/conversation/model"
import type { Resume, SessionId } from "@q/domain/session/model"
import { Context, Data, Effect, Layer, Stream } from "effect"

import { ApiClient } from "./api-client"

// TRANSPORT — how a client reaches one session on the server. The program does not know whether
// the server is across a socket or in the same process; the `ApiClient` Layer does.

/** The request did not complete: no server, a refused session, a broken stream. `message` is for the notice line. */
export class TransportError extends Data.TaggedError("TransportError")<{ readonly cause: unknown }> {
  override get message(): string {
    const cause = this.cause
    if (typeof cause === "object" && cause !== null && "_tag" in cause) {
      switch (cause._tag) {
        case "SessionNotFoundError":
          return "the session is gone"
        case "PersistenceError":
          return `server storage: ${"message" in cause ? String(cause.message) : "failed"}`
        case "HttpClientError":
          return `cannot reach the server: ${"message" in cause ? String(cause.message) : "request failed"}`
      }
    }
    return cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)
  }
}

interface TransportInterface {
  /** Dispatch one intent; the Model as it changes, until the turn is over. */
  readonly send: (intent: Intent) => Stream.Stream<ConversationModel, TransportError>
  /** The current Model, then every change until the turn is over. */
  readonly watch: Stream.Stream<ConversationModel, TransportError>
}

export class Transport extends Context.Service<Transport, TransportInterface>()("@q/client/transport/transport-service/Transport") {
  /** Bind a client to one session. */
  static readonly make = (client: ApiClient["Service"], id: SessionId): TransportInterface => {
    const stream = (request: Effect.Effect<Stream.Stream<ConversationModel, unknown>, unknown>) =>
      Stream.unwrap(request).pipe(Stream.mapError((cause) => new TransportError({ cause })))
    return Transport.of({
      // The generated client takes one request shape per member of the payload union.
      send: (intent) =>
        stream(
          intent._tag === "SubmittedPrompt"
            ? client.sessions.sendIntent({ params: { id }, payload: intent })
            : client.sessions.sendIntent({ params: { id }, payload: intent }),
        ),
      watch: stream(client.sessions.watchSession({ params: { id } })),
    })
  }

  /** The transport of the session `id`, over whichever `ApiClient` is provided. */
  static readonly layer = (id: SessionId): Layer.Layer<Transport, never, ApiClient> =>
    Layer.effect(
      Transport,
      Effect.map(ApiClient, (client) => Transport.make(client, id)),
    )
}

/** Open (or create) the session `resume` names in `cwd`, on the server behind the `ApiClient`. */
export const openSession = Effect.fn("openSession")(
  function* openSession(cwd: string, resume: Resume) {
    const client = yield* ApiClient
    return yield* client.sessions.openSession({ payload: { cwd, resume } })
  },
  Effect.mapError((cause) => new TransportError({ cause })),
)
