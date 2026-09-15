import { Schema } from "effect"

/**
 * A chunk that does not fit the message it was applied to: a `text-delta` for a text part that was
 * never started, a `tool-output-available` for a tool call that was never announced, and so on.
 *
 * The AI SDK throws this error from its reducer. Here `applyChunk` returns it in a `Result`, so a
 * reducer that is pure stays pure and the caller decides what a broken stream means.
 *
 * @since 0.1.0
 */
export class UIMessageStreamError extends Schema.TaggedError<UIMessageStreamError>()("UIMessageStreamError", {
  chunkType: Schema.String,
  chunkId: Schema.String,
  description: Schema.String,
}) {
  override get message(): string {
    return `${this.chunkType} (${this.chunkId}): ${this.description}`
  }
}
