import { ConfigProvider, Effect, Layer } from "effect"
import { FakeAnthropic } from "./FakeAnthropic.ts"

/**
 * The only thing tests change: configuration. Everything else is the real
 * thing, including the model, which is served by `FakeAnthropic` over HTTP
 * (also provided, so tests can see the prompts it received).
 */
export const testConfig = (overrides: Readonly<Record<string, string>> = {}) =>
  Layer.unwrap(
    Effect.gen(function*() {
      const { url } = yield* FakeAnthropic
      return ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          Q_DB_PATH: ":memory:",
          ANTHROPIC_API_KEY: "test",
          Q_ANTHROPIC_URL: url,
          ...overrides
        })
      )
    })
  ).pipe(Layer.provideMerge(FakeAnthropic.layer))

export const TestConfig = testConfig()
