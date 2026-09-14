import { Context, type Duration, Effect, Layer, RcMap, type Scope } from "effect"

import { Runtime } from "@q/kit"
import {
  type Agent,
  type Message,
  type Model,
  type Resume,
  type Session,
  SessionId,
  SessionNotFound,
  StorageFailed,
  Transcript,
  type TranscriptError,
  TranscriptRepository,
  program,
} from "@q/core"

// SESSIONS — the live runtimes, one per session, started on first use. A runtime stays up while a
// request holds it and for `idleTimeToLive` after the last one lets go, so a client can come back
// mid-turn. A turn that outlives that idle window with nobody watching is interrupted; the transcript
// then shows it as interrupted on the next load.

const storageFailed = (error: TranscriptError) => new StorageFailed({ message: error.message })

export class Sessions extends Context.Service<
  Sessions,
  {
    /** Which session `resume` means in `cwd`, creating one when asked. */
    readonly resolve: (resume: Resume, cwd: string) => Effect.Effect<Session, SessionNotFound | StorageFailed>
    readonly list: (cwd: string) => Effect.Effect<ReadonlyArray<Session>, StorageFailed>
    /** The runtime of `id`. Held for the caller's Scope; started if it is not up. */
    readonly runtime: (
      id: SessionId,
    ) => Effect.Effect<Runtime.Runtime<Model, Message>, SessionNotFound | StorageFailed, Scope.Scope>
  }
>()("Sessions") {
  static readonly layer = (options?: {
    readonly idleTimeToLive?: Duration.Input
  }): Layer.Layer<Sessions, never, TranscriptRepository | Agent> =>
    Layer.effect(Sessions)(
      Effect.gen(function* () {
        const repository = yield* TranscriptRepository

        const runtimes = yield* RcMap.make({
          lookup: (id: SessionId) =>
            Effect.gen(function* () {
              yield* repository.findSession(id).pipe(
                Effect.catchTag("NoSuchElementError", () => Effect.fail(new SessionNotFound({ id }))),
                Effect.catchTag("TranscriptError", (error) => Effect.fail(storageFailed(error))),
              )
              return yield* Runtime.make(program).pipe(Effect.provide(Transcript.Of(id)))
            }),
          idleTimeToLive: options?.idleTimeToLive ?? "10 minutes",
        })

        return {
          resolve: (resume, cwd) =>
            Transcript.resolve(resume, cwd).pipe(
              // Only `Resume.Session` can miss: `New` and `Latest` create when there is nothing to resume.
              Effect.catchTag("NoSuchElementError", () =>
                Effect.fail(new SessionNotFound({ id: resume._tag === "Session" ? resume.id : SessionId.make("") })),
              ),
              Effect.catchTag("TranscriptError", (error) => Effect.fail(storageFailed(error))),
              Effect.provideService(TranscriptRepository, repository),
            ),
          list: (cwd) => Effect.mapError(repository.sessions(cwd), storageFailed),
          runtime: (id) => RcMap.get(runtimes, id),
        }
      }),
    )
}
