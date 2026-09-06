import { Array, Context, Data, Effect, Layer, Ref, Schema } from "effect"

import { defineTaggedUnion } from "@q/kit"

// TRANSCRIPT — the durable truth of the conversation.
// Domain events at turn granularity. Never transport chunks. Schema-validated at this boundary.

export const Outcome = defineTaggedUnion({
  Completed: {},
  Cancelled: {},
  Failed: { error: Schema.String },
})
export type Outcome = typeof Outcome.Type

export const ConversationEvent = defineTaggedUnion({
  PromptAccepted: { prompt: Schema.String },
  TurnEnded: { text: Schema.String, outcome: Outcome },
})
export type ConversationEvent = typeof ConversationEvent.Type

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
