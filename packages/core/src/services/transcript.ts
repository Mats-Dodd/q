import { Array, Context, Data, Effect, Layer, Ref } from "effect"

import type { ConversationEvent } from "../domain/event"

// TRANSCRIPT — append-only storage for the conversation events. Schema-validated at this boundary.

export class TranscriptError extends Data.TaggedError("TranscriptError")<{ readonly message: string }> {}

/**
 * Append-only storage for the conversation. In memory today; a file or a server later, same contract.
 *
 * Contract: `append` calls land in the order they were issued. The program does not wait for one
 * append before issuing the next (a turn's `TurnEnded` and the next turn's `PromptAccepted` can be
 * in flight together), so a Layer with real latency must serialise appends itself, for example with
 * a semaphore of one permit or a queue. The in-memory Layer is synchronous and orders for free.
 */
export class Transcript extends Context.Service<
  Transcript,
  {
    readonly append: (event: ConversationEvent) => Effect.Effect<void, TranscriptError>
    readonly load: Effect.Effect<ReadonlyArray<ConversationEvent>, TranscriptError>
  }
>()("Transcript") {}

export const makeInMemoryTranscript = (initial: ReadonlyArray<ConversationEvent> = []): Layer.Layer<Transcript> =>
  Layer.effect(
    Transcript,
    Effect.map(Ref.make(initial), (events) => ({
      append: (event) => Ref.update(events, Array.append(event)),
      load: Ref.get(events),
    })),
  )

export const InMemoryTranscript = makeInMemoryTranscript()
