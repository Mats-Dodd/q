import { PersistenceError } from "@q/domain/persistence-error"
import type { SessionId } from "@q/domain/session/model"
import type { ConversationEvent } from "@q/domain/transcript/model"
import { Context, Effect, Layer, Semaphore } from "effect"
import type { SqlError } from "effect/unstable/sql"

import { TranscriptRepository } from "./transcript-repository"

// TRANSCRIPT SERVICE — append-only storage for conversations. Infrastructure failures leave here as `PersistenceError`.

interface TranscriptServiceInterface {
  /**
   * Appends land in the order they were issued. The program does not wait for one append before
   * issuing the next (a turn's `TurnEnded` and the next turn's `PromptAccepted` can be in flight
   * together), so the service serialises them. SQLite has one writer anyway; one permit costs nothing.
   */
  readonly append: (sessionId: SessionId, event: ConversationEvent) => Effect.Effect<void, PersistenceError>
  /** The events of one session in append order. */
  readonly load: (sessionId: SessionId) => Effect.Effect<ReadonlyArray<ConversationEvent>, PersistenceError>
}

export class TranscriptService extends Context.Service<TranscriptService, TranscriptServiceInterface>()(
  "@q/core/transcript/transcript-service/TranscriptService",
) {
  static readonly layer = Layer.effect(
    TranscriptService,
    Effect.gen(function* layer() {
      const repository = yield* TranscriptRepository
      const writer = yield* Semaphore.make(1)

      const append = Effect.fn("TranscriptService.append")(
        (sessionId: SessionId, event: ConversationEvent) => writer.withPermits(1)(repository.insert(sessionId, event)),
        Effect.catchTag("SqlError", toPersistenceError),
      )

      const load = Effect.fn("TranscriptService.load")(
        (sessionId: SessionId) => repository.findBySessionId(sessionId),
        Effect.catchTag("SqlError", toPersistenceError),
      )

      return TranscriptService.of({ append, load })
    }),
  )

  static readonly live = TranscriptService.layer.pipe(Layer.provide(TranscriptRepository.layer))
}

const toPersistenceError = (cause: SqlError.SqlError) => Effect.fail(PersistenceError.make({ cause, message: cause.message }))
