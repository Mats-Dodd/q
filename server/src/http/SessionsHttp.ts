import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../api/Api.ts"
import { Sessions } from "../services/Sessions.ts"

/**
 * Database failures become defects here. HttpApi turns a defect into an empty
 * 500, `HttpMiddleware.logger` logs the full cause (with span frames), and the
 * handler's `Effect.withErrorReporting` hands it to any installed `ErrorReporter`.
 */
export const SessionsHttp = HttpApiBuilder.group(
  Api,
  "sessions",
  Effect.fnUntraced(function*(handlers) {
    const sessions = yield* Sessions
    return handlers
      .handle("create", ({ payload }) => sessions.create(payload).pipe(Effect.catchTag("SqlError", Effect.die)))
      .handle("list", () => sessions.list.pipe(Effect.catchTag("SqlError", Effect.die)))
      .handle("get", ({ params }) => sessions.get(params.id).pipe(Effect.catchTag("SqlError", Effect.die)))
      .handle("update", ({ params, payload }) =>
        sessions.update(params.id, payload).pipe(Effect.catchTag("SqlError", Effect.die))
      )
      .handle("remove", ({ params }) => sessions.remove(params.id).pipe(Effect.catchTag("SqlError", Effect.die)))
  })
)
