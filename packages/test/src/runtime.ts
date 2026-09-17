import type * as Runtime from "@q/kit/runtime"
import { Effect, Fiber, Layer, Stream } from "effect"
import type { Duration, Scope } from "effect"
import { TestClock } from "effect/testing"

/**
 * Build `layer` in the enclosing Scope and give its services to `self`. In a test body this replaces
 * `Effect.provide(layer)`, which closes the Layer's scope as soon as `self` returns: a runtime made
 * inside `self` would outlive the services it was given. The test's Scope outlives everything the test made.
 */
export const providing =
  <ROut, E2, RIn>(layer: Layer.Layer<ROut, E2, RIn>) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E | E2, Exclude<R, ROut> | RIn | Scope.Scope> =>
    Effect.flatMap(Layer.build(layer), (context) => Effect.provideContext(self, context))

/**
 * Fork a wait for the first Message that satisfies `predicate`. Fork before the dispatch that
 * causes it, join after: completion is a message on the runtime, never a sleep.
 */
export const awaiting = <Model, Message>(runtime: Runtime.Runtime<Model, Message>, predicate: (message: Message) => boolean) =>
  Effect.forkChild(Stream.runHead(Stream.filter(runtime.messages, predicate)), { startImmediately: true })

/**
 * Advance the `TestClock` by `step` until `fiber` is done, then join it. For a wait on a paced
 * stream: `TestClock.adjust` wakes the sleeps registered when it runs, and a stream that sleeps
 * again after each element registers its next sleep only once it has run, so one large adjust
 * does not carry it to the end. What matters is that it arrives, not on which step. Bounded by
 * `frames`; a wait that never ends hangs on the final join and fails the test with a timeout.
 */
export const advancingUntil = <A, E>(fiber: Fiber.Fiber<A, E>, step: Duration.Input = "33 millis", frames = 1000): Effect.Effect<A, E> =>
  Effect.gen(function* () {
    for (let frame = 0; frame < frames && fiber.pollUnsafe() === undefined; frame++) {
      yield* TestClock.adjust(step)
    }
    return yield* Fiber.join(fiber)
  })
