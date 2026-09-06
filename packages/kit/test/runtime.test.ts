import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Layer, Schema, type Scope, Stream } from "effect"
import { TestClock } from "effect/testing"

import { Message, type Model, program } from "./counter.fixture"
import { type Return, replay } from "../src/program"
import * as Runtime from "../src/runtime"
import * as Subscription from "../src/subscription"
import { settle, tick } from "../src/testing"

/** Run a scoped test body against a deterministic clock. Closing the scope interrupts the runtime. */
const run = <A>(body: Effect.Effect<A, never, Scope.Scope | TestClock.TestClock>) =>
  Effect.runPromise(body.pipe(Effect.scoped, Effect.provide(TestClock.layer())))


describe("runtime", () => {
  test("dispatch folds synchronously; replaying the log reproduces the model", () =>
    run(
      Effect.gen(function* () {
        const runtime = yield* Runtime.make(program)
        const log = yield* Effect.forkChild(Stream.runCollect(Stream.take(runtime.messages, 2)))
        yield* Effect.yieldNow

        runtime.dispatch(Message.ClickedIncrement())
        runtime.dispatch(Message.ClickedIncrement())
        expect(runtime.model().count).toBe(2)

        const messages = yield* Fiber.join(log)
        expect(messages).toEqual([Message.ClickedIncrement(), Message.ClickedIncrement()])
        expect(replay(program.update, program.init().model, messages)).toEqual(runtime.model())
      }),
    ))

  test("commands run on the runtime's clock and dispatch their result", () =>
    run(
      Effect.gen(function* () {
        const runtime = yield* Runtime.make(program)
        runtime.dispatch(Message.ClickedIncrement())
        runtime.dispatch(Message.ClickedResetAfterDelay({ seconds: 2 }))
        expect(runtime.model()).toEqual({ count: 1, isResetting: true })

        yield* tick("1 second")
        expect(runtime.model().isResetting).toBe(true)

        yield* tick("1 second")
        expect(runtime.model()).toEqual({ count: 0, isResetting: false })
      }),
    ))

  test("the model stream is observable", () =>
    run(
      Effect.gen(function* () {
        const runtime = yield* Runtime.make(program)
        const models = yield* Effect.forkChild(Stream.runCollect(Stream.take(runtime.models, 2)))
        yield* Effect.yieldNow

        runtime.dispatch(Message.ClickedIncrement())
        runtime.dispatch(Message.ClickedIncrement())
        expect(yield* Fiber.join(models)).toEqual([
          { count: 1, isResetting: false },
          { count: 2, isResetting: false },
        ])
      }),
    ))

  test("onModel fires once per changed model, inside batch", () =>
    run(
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
        runtime.dispatch(Message.ClickedIncrement())
        expect(seen).toEqual([1])
        expect(batches).toBe(1)
      }),
    ))

  test("a throwing update crashes the runtime and is not published", () =>
    run(
      Effect.gen(function* () {
        let crashes = 0
        const boom = (): Return<Model, Message> => {
          throw new Error("boom")
        }
        const runtime = yield* Runtime.make({ ...program, update: boom }, { onCrash: () => { crashes += 1 } })
        const seen: Array<Message> = []
        yield* Effect.forkChild(Stream.runForEach(runtime.messages, (m) => Effect.sync(() => { seen.push(m) })))
        yield* Effect.yieldNow

        runtime.dispatch(Message.ClickedIncrement())
        runtime.dispatch(Message.ClickedIncrement())
        expect(crashes).toBe(1)
        expect(runtime.crashed()).toBe(true)
        yield* settle
        expect(seen).toEqual([])
      }),
    ))

  test("a crashing subscription closes the scope and reports once", () =>
    run(
      Effect.gen(function* () {
        let closed = false
        let crashes = 0
        yield* Effect.addFinalizer(() => Effect.sync(() => { closed = true }))

        const Exploding = Subscription.make<Model, Message>()({
          deps: Schema.Boolean,
          modelToDeps: (model) => model.isResetting,
          depsToStream: (isResetting) => (isResetting ? Stream.fromEffect(Effect.die("boom")) : Stream.empty),
        })
        const runtime = yield* Runtime.make(
          { ...program, subscriptions: { exploding: Exploding } },
          { onCrash: () => { crashes += 1 } },
        )
        runtime.dispatch(Message.ClickedResetAfterDelay({ seconds: 1 }))
        yield* tick("1 second")

        expect(crashes).toBe(1)
        expect(closed).toBe(true)
        expect(runtime.model().isResetting).toBe(true)
      }),
    ))

  test("closing the scope interrupts pending commands", async () => {
    let completed = 0
    await run(
      Effect.gen(function* () {
        const runtime = yield* Runtime.make(program, { onModel: (m) => { if (!m.isResetting) completed += 1 } })
        runtime.dispatch(Message.ClickedResetAfterDelay({ seconds: 5 }))
        yield* tick("1 second")
      }),
    )
    await Effect.runPromise(Effect.provide(tick("10 seconds"), TestClock.layer()))
    expect(completed).toBe(0)
  })

  test("flags are loaded once and handed to init", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        let loads = 0
        const runtime = yield* Runtime.make({
          ...program,
          flags: Effect.sync(() => { loads += 1; return 40 }),
          init: (count: number) => ({ model: { count, isResetting: false } }),
        })
        runtime.dispatch(Message.ClickedIncrement())
        expect(runtime.model().count).toBe(41)
        expect(loads).toBe(1)
      }).pipe(Effect.scoped, Effect.provide(Layer.empty)),
    ))
})
