import { Config, Context, Duration, Layer, Option, Schema } from "effect"

// AGENT CONFIG — which agent backs the loop and how it is tuned. The Anthropic API key itself is read by the
// Anthropic client from `ANTHROPIC_API_KEY`; it is not carried here.

export const AgentProviderSchema = Schema.Literals(["echo", "anthropic"])
export type AgentProvider = typeof AgentProviderSchema.Type

interface AgentConfigInterface {
  readonly provider: AgentProvider
  /** How long the echo agent waits between characters. */
  readonly echoDelay: Duration.Duration
  /** The Anthropic model id. */
  readonly anthropicModel: string
}

export class AgentConfig extends Context.Service<AgentConfig, AgentConfigInterface>()("@q/config/agent-config/AgentConfig") {
  /** `Q_AGENT`; when unset, `anthropic` if an `ANTHROPIC_API_KEY` is present, `echo` otherwise. */
  static readonly provider: Config.Config<AgentProvider> = Config.Literals(["echo", "anthropic"], "Q_AGENT").pipe(
    Config.orElse(() =>
      Config.map(
        Config.option(Config.Redacted("ANTHROPIC_API_KEY")),
        Option.match({ onNone: () => "echo" as const, onSome: () => "anthropic" as const }),
      ),
    ),
  )

  static readonly echoDelay: Config.Config<Duration.Duration> = Config.Duration("Q_ECHO_DELAY").pipe(
    Config.withDefault(Duration.millis(30)),
  )

  static readonly anthropicModel: Config.Config<string> = Config.NonEmptyString("Q_ANTHROPIC_MODEL").pipe(
    Config.withDefault("claude-sonnet-4-5"),
  )

  static readonly layer = Layer.effect(
    AgentConfig,
    Config.map(
      Config.all({ provider: AgentConfig.provider, echoDelay: AgentConfig.echoDelay, anthropicModel: AgentConfig.anthropicModel }),
      AgentConfig.of,
    ),
  )
}
