import { Cause, Effect, Exit, PubSub, Schema, Scope, Stream } from "effect"

import type { Command } from "./command"
import type { Program } from "./program"

export interface Options<Model> {
  /** Wrap a drain of pending messages, e.g. Solid's `batch`, so N messages become one reactive flush. */
  readonly batch?: (run: () => void) => void
  /** Called synchronously with each new Model (reference-unequal to the previous one). */
  readonly onModel?: (model: Model) => void
  /** Called once if a Command or Subscription fails with an unhandled Cause, or `update` throws. */
  readonly onCrash?: (cause: Cause.Cause<unknown>) => void
}

export interface Runtime<Model, Msg> {
  /** Fold a Message into the Model. Synchronous, FIFO, re-entrant safe. Dropped after a crash or dispose. */
  readonly dispatch: (message: Msg) => void
  /** The current Model. */
  readonly model: () => Model
  /** Live stream of committed Messages, from the point of subscription. Consumers own retention. */
  readonly messages: Stream.Stream<Msg>
  /** Live stream of Model changes, from the point of subscription. */
  readonly models: Stream.Stream<Model>
  /** True once the runtime has crashed. */
  readonly crashed: () => boolean
}

/**
 * Build a running Elm loop inside the current Scope. Commands and Subscriptions are forked
 * into that Scope. A crash closes the Scope, interrupting everything. Requires the services
 * `R` that the program's flags, Commands and Subscriptions declare.
 */
export const make = <Model, Msg, R, Flags>(
  program: Program<Model, Msg, R, Flags>,
  options: Options<Model> = {},
): Effect.Effect<Runtime<Model, Msg>, never, R | Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const context = yield* Effect.context<R>()
    const log = yield* PubSub.unbounded<Msg>()
    const models = yield* PubSub.unbounded<Model>()
    const batch = options.batch ?? ((run) => run())
    const report = options.onCrash ?? ((cause) => console.error(Cause.pretty(cause)))

    const flags = yield* program.flags
    const initial = program.init(flags)
    let model = initial.model
    const pending: Array<Msg> = []
    let draining = false
    let crashed = false
    let disposed = false

    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => {
        disposed = true
      }),
    )

    /** Idempotent: the first crash wins, later ones are ignored. Closes the scope on a fresh root fiber. */
    const crash = (cause: Cause.Cause<unknown>) =>
      Effect.sync(() => {
        if (crashed) return
        crashed = true
        pending.length = 0
        report(cause)
        Effect.runFork(Scope.close(scope, Exit.void))
      })

    const forkInScope = (effect: Effect.Effect<void, never, R>) => {
      Effect.runForkWith(context)(Effect.forkIn(effect, scope))
    }

    const runCommand = (command: Command<Msg, R>) =>
      queueMicrotask(() => {
        if (disposed || crashed) return
        forkInScope(
          command.effect.pipe(
            Effect.flatMap((message) => Effect.sync(() => dispatch(message))),
            Effect.catchCause(crash),
          ),
        )
      })

    /** Fold first, publish second: the log only ever contains Messages that were applied. */
    const step = (message: Msg) => {
      const next = program.update(model, message)
      PubSub.publishUnsafe(log, message)
      if (next.model !== model) {
        model = next.model
        PubSub.publishUnsafe(models, model)
        options.onModel?.(model)
      }
      for (const command of next.commands ?? []) runCommand(command)
    }

    const drain = () => {
      draining = true
      try {
        // Messages dispatched while `batch` flushes reactive effects land in `pending`
        // after the inner loop exits, so loop again until it is empty.
        while (pending.length > 0) {
          batch(() => {
            while (pending.length > 0) step(pending.shift()!)
          })
        }
      } catch (error) {
        Effect.runSync(crash(Cause.die(error)))
      } finally {
        draining = false
      }
    }

    const dispatch = (message: Msg) => {
      if (disposed || crashed) return
      pending.push(message)
      if (!draining) drain()
    }

    for (const subscription of Object.values(program.subscriptions ?? {})) {
      const equivalence = Schema.toEquivalence(subscription.deps)
      // Subscribe here, synchronously, before any dispatch can publish: a Stream.fromPubSub
      // inside the forked fiber would subscribe later and miss the first model changes.
      const modelChanges = yield* PubSub.subscribe(models)
      yield* Effect.forkIn(
        Stream.concat(
          Stream.make(subscription.modelToDeps(model)),
          Stream.fromSubscription(modelChanges).pipe(Stream.map(subscription.modelToDeps)),
        ).pipe(
          Stream.changesWith(equivalence),
          Stream.switchMap(subscription.depsToStream),
          Stream.runForEach((message) => Effect.sync(() => dispatch(message))),
          Effect.catchCause(crash),
        ),
        scope,
        { startImmediately: true },
      )
    }

    for (const command of initial.commands ?? []) runCommand(command)

    return {
      dispatch,
      model: () => model,
      messages: Stream.fromPubSub(log),
      models: Stream.fromPubSub(models),
      crashed: () => crashed,
    }
  })
