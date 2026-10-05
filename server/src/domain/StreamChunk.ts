import { Schema } from "effect"
import { uiChunks } from "./UiChunk.ts"
import { MessageText, TurnEndReason, TurnId } from "./Turn.ts"

/**
 * Session-level events, carried as the protocol's `data-*` chunks so every
 * entry in a session stream is a valid UI message chunk. The server is the only
 * writer, so this is a closed set (the protocol allows any `data-${string}`).
 */
export const UserMessageChunk = Schema.Struct({
  type: Schema.Literal("data-user-message"),
  id: TurnId,
  data: Schema.Struct({ text: MessageText })
}).annotate({ identifier: "UserMessageChunk" })

/** A turn has started; `model` is the model it runs on. */
export const TurnStartedChunk = Schema.Struct({
  type: Schema.Literal("data-turn-start"),
  id: TurnId,
  data: Schema.Struct({ model: Schema.String })
}).annotate({ identifier: "TurnStartedChunk" })

export const TurnEndedChunk = Schema.Struct({
  type: Schema.Literal("data-turn-end"),
  id: TurnId,
  data: Schema.Struct({ reason: TurnEndReason })
}).annotate({ identifier: "TurnEndedChunk" })

/** What a session stream holds: each entry (a JSON message, in protocol terms) is one of these. */
export const StreamChunk = Schema.Union([...uiChunks, UserMessageChunk, TurnStartedChunk, TurnEndedChunk]).pipe(
  Schema.toTaggedUnion("type")
).annotate({ identifier: "StreamChunk" })
export type StreamChunk = typeof StreamChunk.Type
