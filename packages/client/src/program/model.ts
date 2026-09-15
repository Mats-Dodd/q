import { ConversationModelSchema } from "@q/domain/conversation/model"
import { Schema } from "effect"

// CLIENT MODEL — a thin mirror of the server. The server's Model as last seen, plus what only this
// client knows: a prompt it has sent but not seen accepted, and a transport notice.

export const ModelSchema = Schema.Struct({
  /** The server's Model as last seen. `None` until the first `watch` answers. */
  remote: Schema.Option(ConversationModelSchema),
  /** A prompt sent and not yet reflected by the server. Shown as pending; blocks a second prompt. */
  pending: Schema.Option(Schema.String),
  /** A one-line transport problem, cleared on the next request. */
  notice: Schema.Option(Schema.String),
})
export type Model = typeof ModelSchema.Type
