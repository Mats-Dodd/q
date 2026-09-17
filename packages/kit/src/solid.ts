import { Cause, Exit, ManagedRuntime, Scope } from "effect"
import type { Layer } from "effect"
import { batch, createMemo, createResource, createSignal, onCleanup } from "solid-js"
import type { Accessor } from "solid-js"

import type { Program } from "./program"
import * as Runtime from "./runtime"

export interface SolidProgram<Model, Msg> {
  /** The current Model as one signal. */
  readonly model: Accessor<Model>
  /** A memoised slice of the Model. Only notifies when the slice changes by reference. */
  readonly select: <Value>(project: (model: Model) => Value) => Accessor<Value>
  readonly dispatch: (message: Msg) => void
  readonly runtime: Runtime.Runtime<Model, Msg>
}

export interface ProgramBoot<Model, Msg> {
  /** Undefined until flags have loaded and the runtime is up. */
  readonly app: Accessor<SolidProgram<Model, Msg> | undefined>
  /** Set once if the runtime crashes. */
  readonly crash: Accessor<Cause.Cause<unknown> | undefined>
}

/**
 * Run a Program for the lifetime of the enclosing Solid owner. Call once, in the root component.
 *
 * Boot is a Solid resource because `flags` may load from somewhere slow or remote. The Model is
 * exposed as a single signal rather than a store: Solid's `reconcile` mutates the previous object
 * graph in place, which would corrupt an immutable Model. With reference-preserving updates,
 * `select` and `<Index>` give the same fine-grained leaf updates without mutation.
 *
 * A Layer that fails to build (a database that will not open, a session that does not exist) is
 * a crash like any other: `crash` is set and `app` stays undefined.
 */
export const createProgram = <Model, Msg, R, E, Flags>(
  program: Program<Model, Msg, R, Flags>,
  layer: Layer.Layer<R, E>,
): ProgramBoot<Model, Msg> => {
  const managed = ManagedRuntime.make(layer)
  const scope = Scope.makeUnsafe()
  const [crash, setCrash] = createSignal<Cause.Cause<unknown>>()
  let setModel: ((model: Model) => void) | undefined

  // console.error is captured by OpenTUI's console overlay, which opens on error.
  const report = (cause: Cause.Cause<unknown>) => {
    // oxlint-disable-next-line effecttsgo/global-console -- see above
    console.error(Cause.pretty(cause))
    setCrash(() => cause)
  }

  const boot = (exit: Exit.Exit<Runtime.Runtime<Model, Msg>, E>): SolidProgram<Model, Msg> | undefined => {
    if (Exit.isFailure(exit)) {
      report(exit.cause)
      return undefined
    }
    const runtime = exit.value
    const [model, set] = createSignal<Model>(runtime.model())
    setModel = (next) => set(() => next)
    const select = <Value>(project: (model: Model) => Value) => createMemo(() => project(model()))
    return { model, select, dispatch: runtime.dispatch, runtime }
  }

  // Solid's resource fetcher is a Promise: this is the one place the Effect world meets Solid's.
  const [app] = createResource(() =>
    managed
      .runPromiseExit(Runtime.make(program, { batch, onModel: (model) => setModel?.(model), onCrash: report }).pipe(Scope.provide(scope)))
      .then(boot),
  )

  onCleanup(() => {
    void managed.runPromise(Scope.close(scope, Exit.void)).then(() => managed.dispose())
  })

  return { app, crash }
}
