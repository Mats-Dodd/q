/**
 * Serves the tests' fake Anthropic API (see `test/support/FakeAnthropic.ts`)
 * for local development without a key or tokens:
 *
 *   bun run fake-anthropic   # http://127.0.0.1:7778
 *   Q_ANTHROPIC_URL=http://127.0.0.1:7778 ANTHROPIC_API_KEY=fake bun run dev
 */
import { BunRuntime } from "@effect/platform-bun"
import { Effect } from "effect"
import { FakeAnthropic } from "../test/support/FakeAnthropic.ts"

const Fake = FakeAnthropic.layerAt(7778)

Effect.gen(function*() {
  const { url } = yield* FakeAnthropic
  yield* Effect.log(`fake Anthropic API at ${url}`)
  return yield* Effect.never
}).pipe(
  // oxlint-disable-next-line effecttsgo/strict-effect-provide -- script entry point
  Effect.provide(Fake),
  BunRuntime.runMain
)
