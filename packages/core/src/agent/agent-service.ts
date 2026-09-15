import { AgentConfig } from "@q/config/agent-config"
import { Context, type Duration, Effect, Layer, Schedule, Schema, Stream } from "effect"

export class AgentError extends Schema.TaggedError<AgentError>()("AgentError", { message: Schema.String }) {}

/** The one thing the app needs from an agent: a stream of text for a prompt. Swap the Layer, keep the app. */
interface AgentServiceInterface {
  readonly stream: (prompt: string) => Stream.Stream<string, AgentError>
}

export class AgentService extends Context.Service<AgentService, AgentServiceInterface>()("@q/core/agent/agent-service/AgentService") {
  /** Echoes the prompt back one character at a time, `delay` apart. Pass `null` for an instant echo. */
  static readonly layerEcho = (delay: Duration.Input | null): Layer.Layer<AgentService> =>
    Layer.succeed(
      AgentService,
      AgentService.of({
        stream: (prompt) => {
          const chars = Stream.fromIterable(prompt)
          return delay === null ? chars : chars.pipe(Stream.schedule(Schedule.spaced(delay)))
        },
      }),
    )

  static readonly live: Layer.Layer<AgentService, never, AgentConfig> = Layer.unwrap(
    Effect.map(AgentConfig, ({ echoDelay }) => AgentService.layerEcho(echoDelay)),
  )
}
