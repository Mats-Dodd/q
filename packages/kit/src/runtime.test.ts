import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, Schedule, Scope, Stream } from "effect"
import { TestClock } from "effect/testing"

import { Message, program } from "./counter.fixture"
import type { Model } from "./counter.fixture"
import * as Command from "./command"
import type { Return } from "./program"
import * as Runtime from "./runtime"
import * as Subscription from "./subscription"

// `it.effect` runs each test in its own Scope on a TestClock; closing the Scope interrupts the runtime.

describe("runtime", () => {
  it.effect("dispatch folds synchronously; replaying the log reproduces the model", () =>
    Effect.gen(function* () {
      const runtime = yield* Runtime.make(program)
      const log = yield* Effect.forkChild(Stream.runCollect(Stream.take(runtime.messages, 2)), { startImmediately: true })

      runtime.dispatch(Message.cases.ClickedIncrement.make({}))
      runtime.dispatch(Message.cases.ClickedIncrement.make({}))
      assert.strictEqual(runtime.model().count, 2)

      const messages = yield* Fiber.join(log)
      assert.deepStrictEqual(messages, [Message.cases.ClickedIncrement.make({}), Message.cases.ClickedIncrement.make({})])
      const replayed = messages.reduce((model, message) => program.update(model, message).model, program.init().model)
      assert.deepStrictEqual(replayed, runtime.model())
    }),
  )

  it.effect("commands run on the runtime's clock and dispatch their result", () =>
    Effect.gen(function* () {
      const runtime = yield* Runtime.make(program)
      const reset = yield* Effect.forkChild(Stream.runHead(Stream.filter(runtime.messages, (m) => m._tag === "CompletedDelayReset")), {
        startImmediately: true,
      })
      runtime.dispatch(Message.cases.ClickedIncrement.make({}))
      runtime.dispatch(Message.cases.ClickedResetAfterDelay.make({ seconds: 2 }))
      assert.deepStrictEqual(runtime.model(), { count: 1, isResetting: true })

      yield* TestClock.adjust("1 second")
      assert.isTrue(runtime.model().isResetting)

      yield* TestClock.adjust("1 second")
      yield* Fiber.join(reset)
      assert.deepStrictEqual(runtime.model(), { count: 0, isResetting: false })
    }),
  )

  it.effect("the model stream is observable", () =>
    Effect.gen(function* () {
      const runtime = yield* Runtime.make(program)
      const models = yield* Effect.forkChild(Stream.runCollect(Stream.take(runtime.models, 2)), { startImmediately: true })

      runtime.dispatch(Message.cases.ClickedIncrement.make({}))
      runtime.dispatch(Message.cases.ClickedIncrement.make({}))
      assert.deepStrictEqual(yield* Fiber.join(models), [
        { count: 1, isResetting: false },
        { count: 2, isResetting: false },
      ])
    }),
  )

  it.effect("onModel fires once per changed model, inside batch", () =>
    Effect.gen(function* () {
      const seen: Array<number> = []
      let batches = 0
      const runtime = yield* Runtime.make(program, {
        batch: (run) => {
          batches += 1
          run()
        },
        onModel: (model) => seen.push(model.count),
      })
      runtime.dispatch(Message.cases.ClickedIncrement.make({}))
      assert.deepStrictEqual(seen, [1])
      assert.strictEqual(batches, 1)
    }),
  )

  it.effect("a throwing update crashes the runtime and is not published", () =>
    Effect.gen(function* () {
      let crashes = 0
      const boom = (): Return<Model, Message> => {
        throw new Error("boom")
      }
      const runtime = yield* Runtime.make(
        { ...program, update: boom },
        {
          onCrash: () => {
            crashes += 1
          },
        },
      )
      const seen: Array<Message> = []
      yield* Effect.forkChild(
        Stream.runForEach(runtime.messages, (m) =>
          Effect.sync(() => {
            seen.push(m)
          }),
        ),
        {
          startImmediately: true,
        },
      )

      runtime.dispatch(Message.cases.ClickedIncrement.make({}))
      runtime.dispatch(Message.cases.ClickedIncrement.make({}))
      assert.strictEqual(crashes, 1)
      assert.isTrue(runtime.crashed())
      yield* Effect.yieldNow
      assert.deepStrictEqual(seen, [])
    }),
  )

  it.effect("a crashing subscription reports once and interrupts the commands in flight", () =>
    Effect.gen(function* () {
      const crashed = yield* Deferred.make<void>()
      let crashes = 0

      const Exploding = Subscription.make<Model, Message>()({
        modelToDeps: (model) => model.isResetting,
        depsToStream: (isResetting) => (isResetting ? Stream.fromEffect(Effect.die("boom")) : Stream.empty),
      })
      const runtime = yield* Runtime.make(
        { ...program, subscriptions: { exploding: Exploding } },
        {
          onCrash: () => {
            crashes += 1
            Deferred.doneUnsafe(crashed, Effect.void)
          },
        },
      )
      runtime.dispatch(Message.cases.ClickedResetAfterDelay.make({ seconds: 1 }))
      yield* Deferred.await(crashed)

      // The DelayReset command was interrupted with the runtime: time passing does not complete it.
      yield* TestClock.adjust("1 second")
      assert.strictEqual(crashes, 1)
      assert.isTrue(runtime.crashed())
      assert.isTrue(runtime.model().isResetting)

      // Dispatch after a crash is dropped.
      runtime.dispatch(Message.cases.ClickedIncrement.make({}))
      assert.strictEqual(runtime.model().count, 0)
    }),
  )

  it.effect("closing the scope interrupts pending commands", () =>
    Effect.gen(function* () {
      let completed = 0
      const scope = yield* Scope.make()
      const runtime = yield* Runtime.make(program, {
        onModel: (m) => {
          if (!m.isResetting) {
            completed += 1
          }
        },
      }).pipe(Scope.provide(scope))
      runtime.dispatch(Message.cases.ClickedResetAfterDelay.make({ seconds: 5 }))
      yield* TestClock.adjust("1 second")
      yield* Scope.close(scope, Exit.void)

      yield* TestClock.adjust("10 seconds")
      assert.strictEqual(completed, 0)
    }),
  )

  it.effect("follow emits the current model first, then every change", () =>
    Effect.gen(function* () {
      const runtime = yield* Runtime.make(program)
      runtime.dispatch(Message.cases.ClickedIncrement.make({}))
      const seen = yield* Effect.forkChild(Stream.runCollect(Stream.take(runtime.follow, 3)), { startImmediately: true })

      runtime.dispatch(Message.cases.ClickedIncrement.make({}))
      runtime.dispatch(Message.cases.ClickedIncrement.make({}))
      assert.deepStrictEqual(
        (yield* Fiber.join(seen)).map((m) => m.count),
        [1, 2, 3],
      )
    }),
  )

  it.effect("a streaming command dispatches each element in order", () =>
    Effect.gen(function* () {
      const Count = Command.defineStream("Count", ({ to }: { to: number }) =>
        Stream.range(1, to).pipe(
          Stream.map(() => Message.cases.ClickedIncrement.make({})),
          Stream.schedule(Schedule.spaced("1 second")),
        ),
      )
      const runtime = yield* Runtime.make({
        ...program,
        update: (model, message) =>
          message._tag === "ClickedResetAfterDelay"
            ? { model, commands: [Count({ to: message.seconds })] }
            : program.update(model, message),
      })
      runtime.dispatch(Message.cases.ClickedResetAfterDelay.make({ seconds: 3 }))
      yield* TestClock.adjust("1 second")
      assert.strictEqual(runtime.model().count, 1)
      yield* TestClock.adjust("2 seconds")
      assert.strictEqual(runtime.model().count, 3)
    }),
  )

  it.effect("flags are loaded once and handed to init", () =>
    Effect.gen(function* () {
      let loads = 0
      const runtime = yield* Runtime.make({
        ...program,
        flags: Effect.sync(() => {
          loads += 1
          return 40
        }),
        init: (count: number) => ({ model: { count, isResetting: false } }),
      })
      runtime.dispatch(Message.cases.ClickedIncrement.make({}))
      assert.strictEqual(runtime.model().count, 41)
      assert.strictEqual(loads, 1)
    }),
  )
})
