import { Api } from "@q/api-definition/api"
import { SessionRuntimeService } from "@q/core/session-runtime/session-runtime-service"
import { SessionService } from "@q/core/session/session-service"
import type { ConversationModel, Intent } from "@q/domain/conversation/model"
import type { Resume, SessionId } from "@q/domain/session/model"
import { Effect, Stream } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"

// HANDLERS — the `sessions` group over the core services. A turn is one response: the Model as it
// changes, until it is idle again. The runtime is held for the request Scope, which the server hands
// to the stream, so the session stays up as long as the client is reading.
//
// Services are resolved when the group is built, not per request: the in-process client
// (`HttpApiTest.groups`) runs handlers in the caller's context, which has none of them.

const untilIdle = (models: Stream.Stream<ConversationModel>) => Stream.takeUntil(models, (model) => model.turn._tag === "Idle")

export const SessionsGroupLayer = HttpApiBuilder.group(Api, "sessions", (handlers) =>
  Effect.gen(function* sessionsGroup() {
    const sessions = yield* SessionService
    const runtimes = yield* SessionRuntimeService

    const listSessions = Effect.fn("SessionsGroupLayer.listSessions")(function* listSessions(cwd: string) {
      yield* Effect.annotateCurrentSpan({ "session.cwd": cwd })
      return yield* sessions.list(cwd)
    })

    const openSession = Effect.fn("SessionsGroupLayer.openSession")(function* openSession(cwd: string, resume: Resume) {
      yield* Effect.annotateCurrentSpan({ "session.cwd": cwd, "session.resume": resume._tag })
      return yield* sessions.resolve(resume, cwd)
    })

    const sendIntent = Effect.fn("SessionsGroupLayer.sendIntent")(function* sendIntent(id: SessionId, intent: Intent) {
      yield* Effect.annotateCurrentSpan({ "session.id": id, intent: intent._tag })
      const runtime = yield* runtimes.get(id)
      // Dispatch folds synchronously; `follow` then starts from the Model that fold produced.
      runtime.dispatch(intent)
      return untilIdle(runtime.follow)
    })

    const watchSession = Effect.fn("SessionsGroupLayer.watchSession")(function* watchSession(id: SessionId) {
      yield* Effect.annotateCurrentSpan({ "session.id": id })
      const runtime = yield* runtimes.get(id)
      return untilIdle(runtime.follow)
    })

    return handlers
      .handle("listSessions", ({ query }) => listSessions(query.cwd))
      .handle("openSession", ({ payload }) => openSession(payload.cwd, payload.resume))
      .handle("sendIntent", ({ params, payload }) => sendIntent(params.id, payload))
      .handle("watchSession", ({ params }) => watchSession(params.id))
  }),
)
