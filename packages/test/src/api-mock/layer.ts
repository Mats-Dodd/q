import { Api } from "@q/api-definition/api"
import { ApiClient } from "@q/client/transport/api-client"
import type { ConversationModel, Intent } from "@q/domain/conversation/model"
import type { PersistenceError } from "@q/domain/persistence-error"
import type { SessionNotFoundError } from "@q/domain/session/errors"
import type { Resume, Session, SessionId } from "@q/domain/session/model"
import { idleModel, makeAnsweredModel } from "@q/factories/conversation-model"
import { makeSession } from "@q/factories/session"
import { Effect, Layer, Stream } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"

import { HttpPlatformLayerTest } from "@q/test/http/platform-layer"

// A scripted server behind the real `ApiClient`: the same encoding, routing and decoding as over a
// socket, with handlers the test writes. Spread `defaultSessionsHandlers` and override what matters.

export interface SessionsHandlersTest {
  readonly listSessions: (cwd: string) => Effect.Effect<ReadonlyArray<Session>, PersistenceError>
  readonly openSession: (cwd: string, resume: Resume) => Effect.Effect<Session, SessionNotFoundError | PersistenceError>
  readonly sendIntent: (
    id: SessionId,
    intent: Intent,
  ) => Effect.Effect<Stream.Stream<ConversationModel>, SessionNotFoundError | PersistenceError>
  readonly watchSession: (id: SessionId) => Effect.Effect<Stream.Stream<ConversationModel>, SessionNotFoundError | PersistenceError>
}

/** One session, idle and empty. A prompt is answered with itself at once; escape returns the current Model. */
export const defaultSessionsHandlers: SessionsHandlersTest = {
  listSessions: () => Effect.succeed([makeSession()]),
  openSession: () => Effect.succeed(makeSession()),
  sendIntent: (_, intent) =>
    Effect.succeed(intent._tag === "SubmittedPrompt" ? Stream.make(makeAnsweredModel(intent.text, intent.text)) : Stream.make(idleModel)),
  watchSession: () => Effect.succeed(Stream.make(idleModel)),
}

export const makeSessionsGroupTest = (impl: SessionsHandlersTest) =>
  HttpApiBuilder.group(Api, "sessions", (handlers) =>
    handlers
      .handle("listSessions", ({ query }) => impl.listSessions(query.cwd))
      .handle("openSession", ({ payload }) => impl.openSession(payload.cwd, payload.resume))
      .handle("sendIntent", ({ params, payload }) => impl.sendIntent(params.id, payload))
      .handle("watchSession", ({ params }) => impl.watchSession(params.id)),
  )

/** The `ApiClient` over a scripted server. Lives in the Scope it is built in. */
export const makeApiClientTest = (impl: SessionsHandlersTest = defaultSessionsHandlers) =>
  ApiClient.layerLocal.pipe(Layer.provide(makeSessionsGroupTest(impl)), Layer.provide(HttpPlatformLayerTest))
