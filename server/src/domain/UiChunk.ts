/**
 * The AI SDK UI message stream protocol (`x-vercel-ai-ui-message-stream: v1`):
 * the chunks an assistant message is streamed as.
 *
 * Ported from `ai@7.0.127`, `packages/ai/src/ui-message-stream/ui-message-chunks.ts`.
 * Copyright Vercel, Inc. Licensed under the Apache License, Version 2.0
 * (https://www.apache.org/licenses/LICENSE-2.0). Changes: rewritten with Effect
 * Schema; the open `data-${string}` chunk is left out in favour of the closed set
 * of session data chunks in `StreamChunk.ts`.
 *
 * Field names belong to the protocol, so these unions are discriminated on `type`
 * rather than `_tag`. Like the original's loose objects, unknown fields are
 * ignored when decoding.
 */
import { Schema } from "effect"

const ProviderMetadata = Schema.Record(Schema.String, Schema.JsonObject)
const ToolMetadata = Schema.JsonObject

/** Why the model stopped generating. */
export const FinishReason = Schema.Literals(["stop", "length", "content-filter", "tool-calls", "error", "other"]).annotate({
  identifier: "FinishReason"
})
export type FinishReason = typeof FinishReason.Type

const PascalCase = (type: string) => type.replace(/(?:^|-)([a-z])/g, (_, letter: string) => letter.toUpperCase())

/** One UI chunk variant: a struct tagged by `type`, named `<Type>Chunk` on the wire. */
const uiChunk = <const Type extends string, const Fields extends Schema.Struct.Fields>(type: Type, fields: Fields) =>
  Schema.Struct({ type: Schema.Literal(type), ...fields }).annotate({ identifier: `${PascalCase(type)}Chunk` })

const toolFields = {
  providerExecuted: Schema.optionalKey(Schema.Boolean),
  providerMetadata: Schema.optionalKey(ProviderMetadata),
  toolMetadata: Schema.optionalKey(ToolMetadata),
  dynamic: Schema.optionalKey(Schema.Boolean)
}

// Message lifecycle

export const StartChunk = uiChunk("start", {
  messageId: Schema.optionalKey(Schema.String),
  messageMetadata: Schema.optionalKey(Schema.Json)
})
export const FinishChunk = uiChunk("finish", {
  finishReason: Schema.optionalKey(FinishReason),
  messageMetadata: Schema.optionalKey(Schema.Json)
})
export const AbortChunk = uiChunk("abort", { reason: Schema.optionalKey(Schema.String) })
export const MessageMetadataChunk = uiChunk("message-metadata", { messageMetadata: Schema.Json })
export const ErrorChunk = uiChunk("error", { errorText: Schema.String })

// Steps

export const StartStepChunk = uiChunk("start-step", {})
export const FinishStepChunk = uiChunk("finish-step", {})
/** Removes all message parts added during the current step. */
export const ResetStepChunk = uiChunk("reset-step", {})

// Text and reasoning

const deltaFields = { id: Schema.String, providerMetadata: Schema.optionalKey(ProviderMetadata) }

export const TextStartChunk = uiChunk("text-start", deltaFields)
export const TextDeltaChunk = uiChunk("text-delta", { ...deltaFields, delta: Schema.String })
export const TextEndChunk = uiChunk("text-end", deltaFields)
export const ReasoningStartChunk = uiChunk("reasoning-start", deltaFields)
export const ReasoningDeltaChunk = uiChunk("reasoning-delta", { ...deltaFields, delta: Schema.String })
export const ReasoningEndChunk = uiChunk("reasoning-end", deltaFields)

// Tools

export const ToolInputStartChunk = uiChunk("tool-input-start", {
  toolCallId: Schema.String,
  toolName: Schema.String,
  title: Schema.optionalKey(Schema.String),
  ...toolFields
})
export const ToolInputDeltaChunk = uiChunk("tool-input-delta", {
  toolCallId: Schema.String,
  inputTextDelta: Schema.String
})
export const ToolInputAvailableChunk = uiChunk("tool-input-available", {
  toolCallId: Schema.String,
  toolName: Schema.String,
  input: Schema.Json,
  title: Schema.optionalKey(Schema.String),
  ...toolFields
})
export const ToolInputErrorChunk = uiChunk("tool-input-error", {
  toolCallId: Schema.String,
  toolName: Schema.String,
  input: Schema.Json,
  errorText: Schema.String,
  title: Schema.optionalKey(Schema.String),
  ...toolFields
})
export const ToolApprovalRequestChunk = uiChunk("tool-approval-request", {
  approvalId: Schema.String,
  toolCallId: Schema.String,
  approvalDescriptor: Schema.optionalKey(Schema.Json),
  inputSchemaInput: Schema.optionalKey(Schema.Json),
  reason: Schema.optionalKey(Schema.String),
  isAutomatic: Schema.optionalKey(Schema.Boolean),
  signature: Schema.optionalKey(Schema.String)
})
export const ToolApprovalResponseChunk = uiChunk("tool-approval-response", {
  approvalId: Schema.String,
  approved: Schema.Boolean,
  reason: Schema.optionalKey(Schema.String),
  providerExecuted: Schema.optionalKey(Schema.Boolean),
  providerMetadata: Schema.optionalKey(ProviderMetadata)
})
export const ToolOutputAvailableChunk = uiChunk("tool-output-available", {
  toolCallId: Schema.String,
  output: Schema.Json,
  preliminary: Schema.optionalKey(Schema.Boolean),
  ...toolFields
})
export const ToolOutputErrorChunk = uiChunk("tool-output-error", {
  toolCallId: Schema.String,
  errorText: Schema.String,
  ...toolFields
})
export const ToolOutputDeniedChunk = uiChunk("tool-output-denied", { toolCallId: Schema.String })

// Sources, files and provider-specific content

export const SourceUrlChunk = uiChunk("source-url", {
  sourceId: Schema.String,
  url: Schema.String,
  title: Schema.optionalKey(Schema.String),
  providerMetadata: Schema.optionalKey(ProviderMetadata)
})
export const SourceDocumentChunk = uiChunk("source-document", {
  sourceId: Schema.String,
  mediaType: Schema.String,
  title: Schema.String,
  filename: Schema.optionalKey(Schema.String),
  providerMetadata: Schema.optionalKey(ProviderMetadata)
})
export const FileChunk = uiChunk("file", {
  url: Schema.String,
  mediaType: Schema.String,
  providerMetadata: Schema.optionalKey(ProviderMetadata)
})
export const ReasoningFileChunk = uiChunk("reasoning-file", {
  url: Schema.String,
  mediaType: Schema.String,
  providerMetadata: Schema.optionalKey(ProviderMetadata)
})
/** `kind` is `<provider>.<kind>`. */
export const CustomChunk = uiChunk("custom", {
  kind: Schema.String,
  providerMetadata: Schema.optionalKey(ProviderMetadata)
})

/** Every UI chunk of the protocol except `data-*` (see `StreamChunk`). */
export const uiChunks = [
  StartChunk,
  FinishChunk,
  AbortChunk,
  MessageMetadataChunk,
  ErrorChunk,
  StartStepChunk,
  FinishStepChunk,
  ResetStepChunk,
  TextStartChunk,
  TextDeltaChunk,
  TextEndChunk,
  ReasoningStartChunk,
  ReasoningDeltaChunk,
  ReasoningEndChunk,
  ToolInputStartChunk,
  ToolInputDeltaChunk,
  ToolInputAvailableChunk,
  ToolInputErrorChunk,
  ToolApprovalRequestChunk,
  ToolApprovalResponseChunk,
  ToolOutputAvailableChunk,
  ToolOutputErrorChunk,
  ToolOutputDeniedChunk,
  SourceUrlChunk,
  SourceDocumentChunk,
  FileChunk,
  ReasoningFileChunk,
  CustomChunk
] as const
