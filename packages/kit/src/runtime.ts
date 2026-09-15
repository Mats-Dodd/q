import { Cause, Effect, Exit, PubSub, Queue, Scope, Stream } from "effect"

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
  /**
   * The current Model, then every change after it. The subscription is taken before the Model is
   * read, so a change can arrive twice but never be missed. For observers that want the whole
   * state without a gap, e.g. a remote view.
   */
  readonly follow: Stream.Stream<Model>
  /** True once the runtime has crashed. */
  readonly crashed: () => boolean
}

/**
 * Build a running Elm loop inside the current Scope. Commands and Subscriptions are forked into a
 * child Scope of it. A crash closes that child Scope, interrupting everything; the caller's Scope
 * stays open. Requires the services `R` that the program's flags, Commands and Subscriptions declare.
 *
 * `dispatch` is synchronous for the view's sake. It hands Commands to a runner fiber through a
 * Queue, so everything after the fold runs on the Effect scheduler: tests drive it with `TestClock`
 * and observe it through `messages`.
 */
export const make = <Model, Msg, R, Flags>(
  program: Program<Model, Msg, R, Flags>,
  options: Options<Model> = {},
): Effect.Effect<Runtime<Model, Msg>, never, R | Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const inner = yield* Scope.fork(scope)
    const log = yield* PubSub.unbounded<Msg>()
    const models = yield* PubSub.unbounded<Model>()
    // The command channel. Failing it is the crash signal: every failure path ends here.
    const commands = yield* Queue.unbounded<Command<Msg, R>, unknown>()
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

    /** Idempotent: the first crash wins, later ones are ignored. Reports here; the runner closes `inner`. */
    const crash = (cause: Cause.Cause<unknown>) => {
      if (crashed) return
      crashed = true
      pending.length = 0
      report(cause)
      Queue.failCauseUnsafe(commands, cause)
    }
    const crashWith = (cause: Cause.Cause<unknown>) => Effect.sync(() => crash(cause))

    /** Fold first, publish second: the log only ever contains Messages that were applied. */
    const step = (message: Msg) => {
      const next = program.update(model, message)
      const changed = next.model !== model
      model = next.model
      for (const command of next.commands ?? []) Queue.offerUnsafe(commands, command)
      outbox.push({ message, model: changed ? model : undefined })
      if (changed) options.onModel?.(model)
    }

    /**
     * Publish after the fold, never inside it: a fiber waiting on a PubSub resumes synchronously in
     * `publishUnsafe`, and if it dispatches, that dispatch must fold at once, not queue behind a
     * drain in progress. A dispatch made during publishing lands in `outbox` and this loop takes it.
     */
    const outbox: Array<{ readonly message: Msg; readonly model: Model | undefined }> = []
    let publishing = false
    const publish = () => {
      if (publishing) return
      publishing = true
      try {
        while (outbox.length > 0) {
          const { message, model } = outbox.shift()!
          PubSub.publishUnsafe(log, message)
          if (model !== undefined) PubSub.publishUnsafe(models, model)
        }
      } finally {
        publishing = false
      }
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
        crash(Cause.die(error))
      } finally {
        draining = false
      }
      publish()
    }

    const dispatch = (message: Msg) => {
      if (disposed || crashed) return
      pending.push(message)
      if (!draining) drain()
    }

    const runCommand = (command: Command<Msg, R>) =>
      Effect.forkIn(
        command.stream.pipe(
          Stream.runForEach((message) => Effect.sync(() => dispatch(message))),
          Effect.catchCause(crashWith),
        ),
        inner,
        { startImmediately: true },
      )

    // The runner lives in the caller's Scope so it can close `inner` without closing itself.
    yield* Effect.forkIn(
      Stream.fromQueue(commands).pipe(
        Stream.runForEach(runCommand),
        Effect.catchCause(() => Scope.close(inner, Exit.void)),
      ),
      scope,
      { startImmediately: true },
    )

    for (const subscription of Object.values(program.subscriptions ?? {})) {
      // Subscribe here, synchronously, before any dispatch can publish: a Stream.fromPubSub
      // inside the forked fiber would subscribe later and miss the first model changes.
      const modelChanges = yield* PubSub.subscribe(models)
      yield* Effect.forkIn(
        Stream.concat(
          Stream.make(subscription.modelToDeps(model)),
          Stream.fromSubscription(modelChanges).pipe(Stream.map(subscription.modelToDeps)),
        ).pipe(
          Stream.changes,
          Stream.switchMap(subscription.depsToStream),
          Stream.runForEach((message) => Effect.sync(() => dispatch(message))),
          Effect.catchCause(crashWith),
        ),
        inner,
        { startImmediately: true },
      )
    }

    for (const command of initial.commands ?? []) Queue.offerUnsafe(commands, command)

    // Subscribe first, read second: a change between the two is delivered twice, never dropped.
    const follow = Stream.unwrap(
      Effect.map(PubSub.subscribe(models), (subscription) => Stream.concat(Stream.make(model), Stream.fromSubscription(subscription))),
    )

    return {
      dispatch,
      model: () => model,
      messages: Stream.fromPubSub(log),
      models: Stream.fromPubSub(models),
      follow,
      crashed: () => crashed,
    }
  })
