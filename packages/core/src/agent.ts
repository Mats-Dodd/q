import { Context, Data, type Duration, Layer, Schedule, Stream } from "effect"

// SERVICE

export class AgentError extends Data.TaggedError("AgentError")<{ readonly message: string }> {}

/** The one thing the app needs from an agent: a stream of text for a prompt. Swap the Layer, keep the app. */
export class Agent extends Context.Service<
  Agent,
  {
    readonly stream: (prompt: string) => Stream.Stream<string, AgentError>
  }
>()("Agent") {}

/** Echoes the prompt back one character at a time, `delay` apart. Pass `null` for an instant echo. */
export const makeEchoAgent = (delay: Duration.Input | null): Layer.Layer<Agent> =>
  Layer.succeed(Agent, {
    stream: (prompt) => {
      const chars = Stream.fromIterable(prompt)
      return delay === null ? chars : chars.pipe(Stream.schedule(Schedule.spaced(delay)))
    },
  })

export const EchoAgent = makeEchoAgent("30 millis")
