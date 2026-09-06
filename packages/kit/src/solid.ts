import { Cause, Exit, type Layer, ManagedRuntime, Scope } from "effect"
import { type Accessor, batch, createMemo, createResource, createSignal, onCleanup } from "solid-js"

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
 */
export const createProgram = <Model, Msg, R, Flags>(
  program: Program<Model, Msg, R, Flags>,
  layer: Layer.Layer<R>,
): ProgramBoot<Model, Msg> => {
  const managed = ManagedRuntime.make(layer)
  const scope = Scope.makeUnsafe()
  const [crash, setCrash] = createSignal<Cause.Cause<unknown>>()
  let setModel: ((model: Model) => void) | undefined

  const [app] = createResource(async (): Promise<SolidProgram<Model, Msg>> => {
    const runtime = await managed.runPromise(
      Runtime.make(program, {
        batch,
        onModel: (model) => setModel?.(model),
        onCrash: (cause) => {
          // console.error is captured by OpenTUI's console overlay, which opens on error.
          console.error(Cause.pretty(cause))
          setCrash(() => cause)
        },
      }).pipe(Scope.provide(scope)),
    )
    const [model, set] = createSignal<Model>(runtime.model())
    setModel = (next) => set(() => next)
    const select = <Value,>(project: (model: Model) => Value) => createMemo(() => project(model()))
    return { model, select, dispatch: runtime.dispatch, runtime }
  })

  onCleanup(() => {
    void managed.runPromise(Scope.close(scope, Exit.void)).finally(() => managed.dispose())
  })

  return { app, crash }
}
