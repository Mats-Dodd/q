import { Config, Context, Duration, Layer } from "effect"

interface AgentConfigInterface {
  /** How long the echo agent waits between characters. */
  readonly echoDelay: Duration.Duration
}

export class AgentConfig extends Context.Service<AgentConfig, AgentConfigInterface>()("@q/config/agent-config/AgentConfig") {
  static readonly echoDelay: Config.Config<Duration.Duration> = Config.Duration("Q_ECHO_DELAY").pipe(
    Config.withDefault(Duration.millis(30)),
  )

  static readonly layer = Layer.effect(
    AgentConfig,
    Config.map(AgentConfig.echoDelay, (echoDelay) => AgentConfig.of({ echoDelay })),
  )
}
