import type { Schema, Stream } from "effect"

/**
 * A Model-gated stream of Messages.
 *
 * `modelToDeps` projects the Model to a small dependency value. Whenever that value changes
 * (by the Schema's structural equivalence) the runtime interrupts the current stream and
 * starts `depsToStream(deps)` anew. So the lifetime of the stream is owned entirely by the
 * Model: to cancel it, change the Model. Return `Stream.empty` when nothing should run.
 */
export interface Subscription<Model, Msg, R = never, Deps = any> {
  readonly deps: Schema.Schema<Deps>
  readonly modelToDeps: (model: Model) => Deps
  readonly depsToStream: (deps: Deps) => Stream.Stream<Msg, never, R>
}

export const make =
  <Model, Msg>() =>
  <Deps, R = never>(config: {
    readonly deps: Schema.Schema<Deps>
    readonly modelToDeps: (model: Model) => Deps
    readonly depsToStream: (deps: Deps) => Stream.Stream<Msg, never, R>
  }): Subscription<Model, Msg, R, Deps> =>
    config
