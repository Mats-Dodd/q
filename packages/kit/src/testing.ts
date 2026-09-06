import { Effect } from "effect"
import { TestClock } from "effect/testing"

// @q/kit/testing — helpers for tests only. Runtime code never imports this entry.

export * from "./story"

/**
 * Let Effect's scheduler drain. `dispatch` is synchronous, but the fibers it wakes
 * (commands, subscriptions) run on the scheduler, which needs the event loop to turn.
 * A command's result crosses several scheduler hops (microtask, fiber start, dispatch),
 * so this yields a few macrotask turns; one is flaky under load.
 */
export const settle: Effect.Effect<void> = Effect.promise(async () => {
  for (let i = 0; i < 4; i += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0))
})

/** Advance the `TestClock`, letting everything before and after it run. */
export const tick = (duration: Parameters<typeof TestClock.adjust>[0]): Effect.Effect<void, never, TestClock.TestClock> =>
  Effect.andThen(settle, Effect.andThen(TestClock.adjust(duration), settle))
