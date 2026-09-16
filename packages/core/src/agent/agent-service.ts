import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import { AgentConfig } from "@q/config/agent-config"
import { AgentToolkit } from "@q/domain/agent/tools"
import type { ChatChunk, ChatMessage } from "@q/domain/conversation/model"
import { Config, Context, type Duration, Effect, type FileSystem, Layer, type Path, Ref, Schedule, Schema, Stream } from "effect"
import { LanguageModel, Prompt } from "effect/unstable/ai"
import type { HttpClient } from "effect/unstable/http"
import type { ChildProcessSpawner } from "effect/unstable/process"
import { convertToModelMessages } from "effect-ai-ui/ModelMessages"
import { toUIMessageStream } from "effect-ai-ui/UIMessageStream"

import { toolHandlers } from "./tool-handlers"

// AGENT SERVICE — one model step over the conversation so far, as UI message chunks. The loop that decides
// whether another step follows lives in the program's `update`; this service is stateless.
// The one place in the app that meets `effect/unstable/ai` and a provider.

export class AgentError extends Schema.TaggedError<AgentError>()("AgentError", { message: Schema.String }) {}

const system = (cwd: string): string =>
  [
    "You are q, a terminal coding agent. Answer briefly.",
    `The working directory is ${cwd}. Relative paths resolve against it.`,
    "Tools: `read` a file, `write` a file, `edit` a file by exact string replacement, run a `bash` command. Use them when they help. Read a file before you edit it.",
  ].join("\n")

/** What one step needs to know beyond the conversation. */
export interface StepOptions {
  /** The session's working directory: where tools resolve paths and commands run. */
  readonly cwd: string
}

/** The platform the tool handlers run on. */
type Platform = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner

interface AgentServiceInterface {
  /** One model call for `messages`: `start-step`, whatever the model produces, `finish-step`. Swap the Layer, keep the app. */
  readonly step: (messages: ReadonlyArray<ChatMessage>, options: StepOptions) => Stream.Stream<ChatChunk, AgentError>
}

/** A step is complete on its own: what the reducer needs to fold it into a message. */
const step = (chunks: Stream.Stream<ChatChunk, AgentError>): Stream.Stream<ChatChunk, AgentError> =>
  Stream.succeed<ChatChunk>({ type: "start-step" }).pipe(
    Stream.concat(chunks),
    Stream.concat(Stream.succeed<ChatChunk>({ type: "finish-step" })),
  )

/** The text of the last user message, for agents that answer without a model. */
const lastUserText = (messages: ReadonlyArray<ChatMessage>): string =>
  messages
    .findLast((message) => message.role === "user")
    ?.parts.flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("") ?? ""

export class AgentService extends Context.Service<AgentService, AgentServiceInterface>()("@q/core/agent/agent-service/AgentService") {
  /**
   * Over any `LanguageModel`, with the agent's tools bound to the step's working directory. The platform
   * services are taken once, here; each step binds the handlers to its `cwd`, which costs no I/O.
   */
  static readonly layer: Layer.Layer<AgentService, never, LanguageModel.LanguageModel | Platform> = Layer.effect(
    AgentService,
    Effect.gen(function* layer() {
      const model = yield* LanguageModel.LanguageModel
      const platform = yield* Effect.context<Platform>()
      return AgentService.of({
        step: (messages, { cwd }) =>
          Stream.unwrap(
            Effect.gen(function* step() {
              const handlers = yield* Effect.provideContext(toolHandlers(cwd), platform)
              const toolkit = yield* Effect.provideContext(AgentToolkit, handlers)
              return model.streamText({ prompt: Prompt.setSystem(convertToModelMessages(messages), system(cwd)), toolkit }).pipe(
                toUIMessageStream(AgentToolkit, { onError: (error) => String(error) }),
                Stream.mapError((error) => new AgentError({ message: error.message })),
              )
            }),
          ),
      })
    }),
  )

  /** Echoes the last prompt back one character at a time, `delay` apart. Pass `null` for an instant echo. */
  static readonly layerEcho = (delay: Duration.Input | null): Layer.Layer<AgentService> =>
    Layer.succeed(
      AgentService,
      AgentService.of({
        step: (messages) => {
          const id = "echo"
          const chars = Stream.fromIterable(lastUserText(messages)).pipe(
            Stream.map((delta): ChatChunk => ({ type: "text-delta", id, delta })),
          )
          const paced = delay === null ? chars : chars.pipe(Stream.schedule(Schedule.spaced(delay)))
          return step(
            Stream.succeed<ChatChunk>({ type: "text-start", id }).pipe(
              Stream.concat(paced),
              Stream.concat(Stream.succeed<ChatChunk>({ type: "text-end", id })),
            ),
          )
        },
      }),
    )

  /**
   * Plays `steps` back in order, one per call, each wrapped in `start-step`/`finish-step`; an `AgentError`
   * entry fails that step after `start-step`. Calls past the end are empty steps. For tests.
   */
  static readonly layerScripted = (steps: ReadonlyArray<ReadonlyArray<ChatChunk> | AgentError>): Layer.Layer<AgentService> =>
    Layer.effect(
      AgentService,
      Effect.gen(function* layerScripted() {
        const calls = yield* Ref.make(0)
        return AgentService.of({
          step: () =>
            Stream.unwrap(
              Effect.map(
                Ref.getAndUpdate(calls, (n) => n + 1),
                (n) => {
                  const scripted = steps[n] ?? []
                  return step(scripted instanceof AgentError ? Stream.fail(scripted) : Stream.fromIterable(scripted))
                },
              ),
            ),
        })
      }),
    )

  /** Anthropic, with the key from `ANTHROPIC_API_KEY`. */
  static readonly layerAnthropic = (model: string): Layer.Layer<AgentService, Config.ConfigError, HttpClient.HttpClient | Platform> =>
    AgentService.layer.pipe(
      Layer.provide(AnthropicLanguageModel.layer({ model })),
      // `layerConfig()` with no options sends no key at all; name it.
      Layer.provide(AnthropicClient.layerConfig({ apiKey: Config.Redacted("ANTHROPIC_API_KEY") })),
    )

  /** The agent `AgentConfig` names. */
  static readonly live: Layer.Layer<AgentService, Config.ConfigError, AgentConfig | HttpClient.HttpClient | Platform> = Layer.unwrap(
    Effect.map(AgentConfig, (config) => {
      switch (config.provider) {
        case "echo":
          return AgentService.layerEcho(config.echoDelay)
        case "anthropic":
          return AgentService.layerAnthropic(config.anthropicModel)
      }
    }),
  )
}
