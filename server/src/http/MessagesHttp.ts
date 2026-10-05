import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../api/Api.ts"
import { SessionRuntimes } from "../services/SessionRuntimes.ts"

export const MessagesHttp = HttpApiBuilder.group(
  Api,
  "messages",
  Effect.fnUntraced(function*(handlers) {
    const runtimes = yield* SessionRuntimes
    return handlers
      .handle("send", ({ params, payload }) =>
        runtimes.sendMessage(params.id, payload).pipe(Effect.catchTag("SqlError", Effect.die)))
      .handle("cancel", ({ params }) => runtimes.cancel(params.id))
  })
)
