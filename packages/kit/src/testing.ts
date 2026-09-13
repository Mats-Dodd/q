// @q/kit/testing — helpers for tests only. Runtime code never imports this entry.
//
// Effect tests need nothing from here: `@effect/vitest` runs them on a `TestClock`, and the
// runtime is observed through `Runtime.messages`. What remains is the story DSL for pure `update`.

export * from "./story"
