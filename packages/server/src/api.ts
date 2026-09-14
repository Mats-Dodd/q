import { Effect, Stream } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"

import { Api, type Model } from "@q/core"
import { Sessions } from "./sessions"

// HANDLERS — the `Api` over `Sessions`. A turn is one response: the Model as it changes, until it is
// idle again. The runtime is held for the request Scope, which the server hands to the stream, so
// the session stays up as long as the client is reading.

const untilIdle = (models: Stream.Stream<Model>) => Stream.takeUntil(models, (model) => model.turn._tag === "Idle")

export const SessionsHandlers = HttpApiBuilder.group(
  Api,
  "sessions",
  (handlers) =>
    Effect.gen(function* () {
      const sessions = yield* Sessions
      return handlers
        .handle("list", ({ query }) => sessions.list(query.cwd))
        .handle("open", ({ payload }) => sessions.resolve(payload.resume, payload.cwd))
        .handle("send", ({ params, payload }) =>
          Effect.map(sessions.runtime(params.id), (runtime) => {
            // Dispatch folds synchronously; `follow` then starts from the Model that fold produced.
            runtime.dispatch(payload)
            return untilIdle(runtime.follow)
          }),
        )
        .handle("watch", ({ params }) => Effect.map(sessions.runtime(params.id), (runtime) => untilIdle(runtime.follow)))
    }),
)

/** The whole API on a router, with its OpenAPI document at `/openapi.json`. Needs the group handlers. */
export const ApiLayer = HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" })
