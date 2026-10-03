/** Exercises a running server through the typed client: `bun run client`. */
import { BunRuntime } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { ApiClient } from "../src/client/ApiClient.ts"
import { SessionId } from "../src/domain/Session.ts"

const program = Effect.gen(function*() {
  const client = yield* ApiClient

  const health = yield* client.system.health()
  yield* Effect.log("health", health)

  const created = yield* client.sessions.create({ payload: { title: "hello from the typed client" } })
  yield* Effect.log("created", created)

  const sessions = yield* client.sessions.list()
  yield* Effect.log(`listed ${sessions.length} session(s)`)

  const missing = SessionId.make("00000000-0000-7000-8000-000000000000")
  yield* client.sessions.get({ params: { id: missing } }).pipe(
    Effect.catchTag("SessionNotFound", (error) => Effect.log(`typed error: ${error._tag} (${error.id})`))
  )
})

program.pipe(
  // oxlint-disable-next-line effecttsgo/strict-effect-provide -- script entry point
  Effect.provide(ApiClient.layer.pipe(Layer.provide(FetchHttpClient.layer))),
  BunRuntime.runMain
)
