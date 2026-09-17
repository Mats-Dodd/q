import type { Stream } from "effect"

/**
 * A Model-gated stream of Messages.
 *
 * `modelToDeps` projects the Model to a small dependency value. Whenever that value changes
 * (by `Equal.equals`, which compares plain objects, arrays and Options structurally) the runtime
 * interrupts the current stream and starts `depsToStream(deps, model)` anew, with the Model that
 * produced the new deps. So the lifetime of the stream is owned entirely by the Model: to cancel
 * it, change the Model. Return `Stream.empty` when nothing should run.
 *
 * The Model argument is a snapshot at the moment the stream starts, for inputs too large to be
 * deps (the conversation so far). It does not update while the stream runs.
 *
 * `Deps` is `any` by default so that subscriptions with different deps fit one list; `make` pins it.
 */
// oxlint-disable-next-line typescript/no-explicit-any -- see above
export interface Subscription<Model, Msg, R = never, Deps = any> {
  readonly modelToDeps: (model: Model) => Deps
  readonly depsToStream: (deps: Deps, model: Model) => Stream.Stream<Msg, never, R>
}

/** Curried so `Deps` is inferred from `modelToDeps` and checked against `depsToStream`. Returns `config` unchanged. */
export const make =
  <Model, Msg>() =>
  <Deps, R = never>(config: {
    readonly modelToDeps: (model: Model) => Deps
    readonly depsToStream: (deps: Deps, model: Model) => Stream.Stream<Msg, never, R>
  }): Subscription<Model, Msg, R, Deps> =>
    config
