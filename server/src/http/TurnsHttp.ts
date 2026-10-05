import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../api/Api.ts"
import { SessionRuntimes } from "../services/SessionRuntimes.ts"

export const TurnsHttp = HttpApiBuilder.group(
  Api,
  "turns",
  Effect.fnUntraced(function*(handlers) {
    const runtimes = yield* SessionRuntimes
    return handlers
      .handle("start", ({ params, payload }) =>
        runtimes.startTurn(params.id, payload).pipe(Effect.catchTag("SqlError", Effect.die)))
      .handle("cancel", ({ params }) => runtimes.cancelTurn(params.id))
  })
)
