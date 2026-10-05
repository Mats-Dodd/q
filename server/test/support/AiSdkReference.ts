import type { LanguageModelV4StreamPart } from "@ai-sdk/provider"
import { streamText, uiMessageChunkSchema } from "ai"
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test"
import { Effect, Stream } from "effect"

/**
 * The AI SDK itself (`ai`, pinned to the version `domain/UiChunk.ts` ports), used
 * as the reference implementation of the UI message stream protocol.
 */

/** Whether the AI SDK accepts `json` as a UI message chunk. */
export const isAiSdkChunk = (json: unknown) =>
  Effect.promise(() => Promise.resolve(uiMessageChunkSchema().validate?.(json))).pipe(
    Effect.map((result) => result?.success === true)
  )

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined }
}

/** The UI message chunks the AI SDK emits for a model that streams `text` in `deltas`. */
export const aiSdkChunksForText = (deltas: ReadonlyArray<string>) =>
  Stream.fromReadableStream({
    evaluate: () => {
      const parts: Array<LanguageModelV4StreamPart> = [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t0" },
        ...deltas.map((delta) => ({ type: "text-delta", id: "t0", delta }) as const),
        { type: "text-end", id: "t0" },
        { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage }
      ]
      const model = new MockLanguageModelV4({
        doStream: () => Promise.resolve({ stream: convertArrayToReadableStream(parts) })
      })
      return streamText({ model, prompt: "hi" }).toUIMessageStream()
    },
    onError: (error) => error
  }).pipe(Stream.runCollect, Effect.orDie)
