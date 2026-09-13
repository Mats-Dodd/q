import { Cause, Context, Effect, Layer, Semaphore } from "effect"

import { defineTaggedUnion } from "@q/kit"
import type { ConversationEvent } from "../domain/event"
import { SessionId } from "../domain/session"
import { TranscriptError, TranscriptRepository } from "./repository"

// TRANSCRIPT — append-only storage for one conversation. Schema-validated at this boundary.

export { TranscriptError }

/** Which session a launch of `q` continues. Decided at the composition root, from the command line. */
export const Resume = defineTaggedUnion({
  /** Start a new session. */
  New: {},
  /** The latest session for the working directory, or a new one if there is none. */
  Latest: {},
  /** A specific session. Unknown ids fail the Layer. */
  Session: { id: SessionId },
})
export type Resume = typeof Resume.Type

/**
 * Append-only storage for the conversation. One session; the Layer decides which.
 *
 * Contract: `append` calls land in the order they were issued. The program does not wait for one
 * append before issuing the next (a turn's `TurnEnded` and the next turn's `PromptAccepted` can be
 * in flight together), so a Layer with real latency must serialise appends itself, for example with
 * a semaphore of one permit or a queue.
 */
export class Transcript extends Context.Service<
  Transcript,
  {
    readonly append: (event: ConversationEvent) => Effect.Effect<void, TranscriptError>
    readonly load: Effect.Effect<ReadonlyArray<ConversationEvent>, TranscriptError>
  }
>()("Transcript") {
  /**
   * The `Transcript` of one session, over the repository. Resolves the session when the Layer is
   * built, then binds `append` and `load` to it. Appends go through one permit, per the contract.
   */
  static readonly Session = (
    resume: Resume,
    cwd: string,
  ): Layer.Layer<Transcript, TranscriptError, TranscriptRepository> =>
    Layer.effect(Transcript)(
      Effect.gen(function* () {
        const repository = yield* TranscriptRepository
        const session = yield* Resume.match(resume, {
          New: () => repository.createSession(cwd),
          Latest: () =>
            repository.sessions(cwd).pipe(
              Effect.head,
              Effect.catchTag("NoSuchElementError", () => repository.createSession(cwd)),
            ),
          Session: ({ id }) =>
            repository.findSession(id).pipe(
              Effect.catchTag("NoSuchElementError", () =>
                Effect.fail(new TranscriptError({ cause: new Cause.NoSuchElementError(`no session ${id}`) })),
              ),
            ),
        })
        const permit = yield* Semaphore.make(1)
        return {
          append: (event) => permit.withPermits(1)(repository.append(session.id, event)),
          load: repository.events(session.id),
        }
      }),
    )
}
