import { assert, it } from "@effect/vitest"
import { SessionNotFoundError } from "@q/domain/session/errors"
import { ResumeSchema } from "@q/domain/session/model"
import { idleModel, makeAnsweredModel, makeStreamingModel } from "@q/factories/conversation-model"
import { makeSession, makeSessionId } from "@q/factories/session"
import * as Runtime from "@q/kit/runtime"
import { defaultSessionsHandlers, makeApiClientTest } from "@q/test/api-mock/layer"
import { awaiting, providing } from "@q/test/runtime"
import { Effect, Fiber, Option, Stream } from "effect"

import { openSession, Transport } from "@q/client/transport/transport-service"
import { MessageSchema } from "./message"
import type { Message } from "./message"
import type { Model } from "./model"
import { program } from "./program"

// The client program against a scripted server behind the real `ApiClient`: the same encoding and
// routing as HTTP, with handlers the test writes. Completion is a message on the runtime.

const remote = (runtime: Runtime.Runtime<Model, Message>) => Option.getOrThrow(runtime.model().remote)
const completed = (m: Message) => m._tag === "CompletedRequest"

/** The client program on a new runtime, over the session `openSession` returns. */
const boot = Effect.gen(function* () {
  const session = yield* openSession("/test", ResumeSchema.cases.New.make({}))
  return yield* Runtime.make(program).pipe(providing(Transport.layer(session.id)))
})

it.effect("boot mirrors the session; a prompt streams the turn into the mirror", () =>
  Effect.gen(function* () {
    const runtime = yield* boot
    assert.deepStrictEqual(runtime.model().remote, Option.none())
    yield* Fiber.join(yield* awaiting(runtime, completed))
    assert.deepStrictEqual(remote(runtime), idleModel)

    const done = yield* awaiting(runtime, completed)
    runtime.dispatch(MessageSchema.cases.SubmittedPrompt.make({ text: "hello" }))
    assert.deepStrictEqual(runtime.model().pending, Option.some("hello"))
    yield* Fiber.join(done)
    assert.deepStrictEqual(runtime.model().pending, Option.none())
    assert.deepStrictEqual(remote(runtime), makeAnsweredModel("hello", "hello"))
  }).pipe(
    providing(
      makeApiClientTest({
        ...defaultSessionsHandlers,
        sendIntent: (_, intent) =>
          Effect.succeed(
            intent._tag === "SubmittedPrompt"
              ? Stream.make(
                  makeStreamingModel(intent.text, ""),
                  makeStreamingModel(intent.text, intent.text),
                  makeAnsweredModel(intent.text, intent.text),
                )
              : Stream.make(idleModel),
          ),
      }),
    ),
  ),
)

it.effect("a session that is gone is a notice, not a crash", () =>
  Effect.gen(function* () {
    const runtime = yield* Runtime.make(program).pipe(providing(Transport.layer(makeSessionId("gone"))))
    yield* Fiber.join(yield* awaiting(runtime, (m) => m._tag === "FailedRequest"))
    assert.deepStrictEqual(runtime.model().notice, Option.some("the session is gone"))
    assert.isFalse(runtime.crashed())
  }).pipe(
    providing(
      makeApiClientTest({
        ...defaultSessionsHandlers,
        watchSession: (id) => Effect.fail(SessionNotFoundError.make({ sessionId: id })),
      }),
    ),
  ),
)

it.effect("an unknown session id is a TransportError on open", () =>
  Effect.gen(function* () {
    const failed = yield* Effect.flip(openSession("/test", ResumeSchema.cases.Session.make({ id: makeSessionId("nope") })))
    assert.strictEqual(failed._tag, "TransportError")
    assert.strictEqual(failed.message, "the session is gone")
    assert.strictEqual((yield* openSession("/test", ResumeSchema.cases.New.make({}))).id, makeSession().id)
  }).pipe(
    providing(
      makeApiClientTest({
        ...defaultSessionsHandlers,
        openSession: (_, resume) =>
          resume._tag === "Session" ? Effect.fail(SessionNotFoundError.make({ sessionId: resume.id })) : Effect.succeed(makeSession()),
      }),
    ),
  ),
)
