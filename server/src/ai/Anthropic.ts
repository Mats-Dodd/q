import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import { Effect, Layer, Option } from "effect"
import { ServerConfig } from "../ServerConfig.ts"

/**
 * The `LanguageModel` turns run on: Anthropic, configured by `ServerConfig`
 * (`ANTHROPIC_API_KEY`, `Q_MODEL`, `Q_ANTHROPIC_URL`). Requires an `HttpClient`
 * from the edge that runs it.
 */
export const layer = Layer.unwrap(
  Effect.gen(function*() {
    const { anthropicApiKey, anthropicUrl, model } = yield* ServerConfig
    return AnthropicLanguageModel.layer({ model }).pipe(
      Layer.provide(AnthropicClient.layer({ apiKey: anthropicApiKey, apiUrl: Option.getOrUndefined(anthropicUrl) }))
    )
  })
)
