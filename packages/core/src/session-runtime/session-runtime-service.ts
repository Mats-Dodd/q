import type { ConversationModel } from "@q/domain/conversation/model"
import type { PersistenceError } from "@q/domain/persistence-error"
import type { SessionNotFoundError } from "@q/domain/session/errors"
import type { SessionId } from "@q/domain/session/model"
import * as Runtime from "@q/kit/runtime"
import { Context, Effect, Layer, RcMap } from "effect"
import type { Scope } from "effect"

import type { AgentService } from "@q/core/agent/agent-service"
import type { Message } from "@q/core/program/message"
import { program } from "@q/core/program/program"
import { CurrentSession } from "@q/core/session/current-session"
import { SessionService } from "@q/core/session/session-service"
import type { TranscriptService } from "@q/core/transcript/transcript-service"

// SESSION RUNTIME — the live runtimes, one per session, started on first use. A runtime stays up while a
// request holds it and for `IDLE_TIME_TO_LIVE` after the last one lets go, so a client can come back
// mid-turn. A turn that outlives that idle window with nobody watching is interrupted; the transcript
// then shows it as interrupted on the next load.

const IDLE_TIME_TO_LIVE = "10 minutes"

export type SessionRuntime = Runtime.Runtime<ConversationModel, Message>

interface SessionRuntimeServiceInterface {
  /** The runtime of `id`. Held for the caller's Scope; started if it is not up. */
  readonly get: (id: SessionId) => Effect.Effect<SessionRuntime, SessionNotFoundError | PersistenceError, Scope.Scope>
}

export class SessionRuntimeService extends Context.Service<SessionRuntimeService, SessionRuntimeServiceInterface>()(
  "@q/core/session-runtime/session-runtime-service/SessionRuntimeService",
) {
  static readonly layer: Layer.Layer<SessionRuntimeService, never, SessionService | TranscriptService | AgentService> = Layer.effect(
    SessionRuntimeService,
    Effect.gen(function* layer() {
      const sessions = yield* SessionService

      const runtimes = yield* RcMap.make({
        lookup: Effect.fn("SessionRuntimeService.start")(function* start(id: SessionId) {
          const session = yield* sessions.findById(id)
          return yield* Runtime.make(program).pipe(Effect.provideService(CurrentSession, session))
        }),
        idleTimeToLive: IDLE_TIME_TO_LIVE,
      })

      return SessionRuntimeService.of({ get: (id) => RcMap.get(runtimes, id) })
    }),
  )
}
