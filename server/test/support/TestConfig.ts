import { ConfigProvider } from "effect"

/** The only thing tests change: configuration. Everything else is the real thing. */
export const TestConfig = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    Q_DB_PATH: ":memory:"
  })
)
