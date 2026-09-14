import { Context, Data, Effect, Layer, Stream } from "effect"
import type { HttpClient } from "effect/unstable/http"
import { HttpApiClient, HttpApiTest } from "effect/unstable/httpapi"

import { Api, type Intent, type Model, type Resume, type Session, type SessionId } from "@q/core"

// TRANSPORT — how a client reaches one session on the server. The program does not know whether
// the server is across a socket or in the same process; the Layer does.

/** The request did not complete: no server, a refused session, a broken stream. `message` is for the notice line. */
export class TransportError extends Data.TaggedError("TransportError")<{ readonly cause: unknown }> {
  override get message(): string {
    const cause = this.cause
    if (typeof cause === "object" && cause !== null && "_tag" in cause) {
      switch (cause._tag) {
        case "SessionNotFound":
          return "the session is gone"
        case "StorageFailed":
          return `server storage: ${"message" in cause ? String(cause.message) : "failed"}`
        case "HttpClientError":
          return `cannot reach the server: ${"message" in cause ? String(cause.message) : "request failed"}`
      }
    }
    return cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)
  }
}

/** The typed client generated from `Api`. */
export type ApiClient = Effect.Success<ReturnType<typeof makeApiClient>>
const makeApiClient = (baseUrl?: string) => HttpApiClient.make(Api, { baseUrl })

export class Transport extends Context.Service<
  Transport,
  {
    /** Dispatch one intent; the Model as it changes, until the turn is over. */
    readonly send: (intent: Intent) => Stream.Stream<Model, TransportError>
    /** The current Model, then every change until the turn is over. */
    readonly watch: Stream.Stream<Model, TransportError>
  }
>()("Transport") {
  /** Bind a client to one session. */
  static readonly fromClient = (client: ApiClient, id: SessionId): Transport["Service"] => {
    const stream = (request: Effect.Effect<Stream.Stream<Model, unknown>, unknown>) =>
      Stream.unwrap(request).pipe(Stream.mapError((cause) => new TransportError({ cause })))
    return {
      // The generated client takes one request shape per member of the payload union.
      send: (intent) =>
        stream(
          intent._tag === "SubmittedPrompt"
            ? client.sessions.send({ params: { id }, payload: intent })
            : client.sessions.send({ params: { id }, payload: intent }),
        ),
      watch: stream(client.sessions.watch({ params: { id } })),
    }
  }

  /** Over HTTP, at `url`. */
  static readonly Http = (url: string, id: SessionId): Layer.Layer<Transport, never, HttpClient.HttpClient> =>
    Layer.effect(Transport)(Effect.map(makeApiClient(url), (client) => Transport.fromClient(client, id)))

  /**
   * In the same process, over the server's handlers: the same encoding and routing as HTTP,
   * without a socket. The handlers must outlive this Layer.
   */
  static readonly Local = (id: SessionId) => Layer.effect(Transport)(Effect.map(Client.local, (client) => Transport.fromClient(client, id)))
}

/** Open (or create) the session `resume` names in `cwd`, on the server behind `client`. */
export const open = (client: ApiClient, cwd: string, resume: Resume): Effect.Effect<Session, TransportError> =>
  Effect.mapError(client.sessions.open({ payload: { cwd, resume } }), (cause) => new TransportError({ cause }))

/** Clients for the two places a server can be. */
export const Client = {
  http: (url: string): Effect.Effect<ApiClient, never, HttpClient.HttpClient> => makeApiClient(url),
  local: HttpApiTest.groups(Api, ["sessions"]),
}
