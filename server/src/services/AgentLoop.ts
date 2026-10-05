import { Context, Data, Effect, Layer, Stream } from "effect"
import { type AiError, LanguageModel, type Prompt } from "effect/ai"
import { AgentOutput } from "../domain/AgentOutput.ts"

/** What to tell the user about an error. */
export const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : typeof error === "string" ? error : "The model reported an error"

/** The model reported an error mid-output: the turn fails with it. */
export class ModelError extends Data.TaggedError("ModelError")<{ readonly message: string }> {}

/**
 * The agent: given the conversation so far, the model's output, step by step.
 * It knows nothing of sessions or storage; whoever runs it records what it
 * produces, and stops it by interrupting. (Tools will make this a loop: call
 * the model, run what it asks for, call it again.)
 */
export interface AgentLoopShape {
  readonly run: (history: Prompt.Prompt) => Stream.Stream<AgentOutput, AiError.AiError | ModelError>
}

export class AgentLoop extends Context.Service<AgentLoop, AgentLoopShape>()("@q/server/services/AgentLoop", {
  make: Effect.gen(function*() {
    const model = yield* LanguageModel.LanguageModel

    const run = (history: Prompt.Prompt) =>
      Stream.concat(
        Stream.succeed(AgentOutput.StepStarted()),
        model.streamText({ prompt: history }).pipe(
          Stream.mapEffect((part) =>
            part.type === "error"
              ? Effect.fail(new ModelError({ message: errorText(part.error) }))
              : Effect.succeed(AgentOutput.Part({ part }))
          )
        )
      ).pipe(Stream.withSpan("AgentLoop.run"))

    return { run } satisfies AgentLoopShape
  })
}) {
  static readonly layer = Layer.effect(AgentLoop, AgentLoop.make)
}
