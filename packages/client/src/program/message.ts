import { ConversationModelSchema, IntentSchema } from "@q/domain/conversation/model"
import { Schema } from "effect"

// CLIENT MESSAGE — the user's intents are the domain's own schemas, not copies, so an intent is sent
// as it is. What comes back from a request is local to the client; the server never sees it.

export const MessageSchema = Schema.Union([
  ...IntentSchema.members,
  Schema.TaggedStruct("ReceivedModel", { model: ConversationModelSchema }),
  Schema.TaggedStruct("CompletedRequest", {}),
  Schema.TaggedStruct("FailedRequest", { error: Schema.String }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type Message = typeof MessageSchema.Type
