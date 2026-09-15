import { Schema } from "effect"
import { Tool, type Toolkit } from "effect/unstable/ai"

import { ProviderMetadata, type ToolsOf } from "./ui-message"

/**
 * The AI SDK UI message stream protocol: one JSON object per SSE event. These are the chunks a
 * server sends and `useChat` folds into a `UIMessage`.
 *
 * Tool chunks are typed from a `Toolkit` where the protocol makes it possible. `tool-input-available`
 * names its tool, so its `input` is that tool's encoded parameters. `tool-output-available` names only
 * the call, so its `output` is the union of every tool's encoded success; the reducer matches it to
 * the call it answers.
 *
 * @since 0.1.0
 */

const withMetadata = { providerMetadata: Schema.optionalKey(ProviderMetadata) }

/** @since 0.1.0 */
export const TextStartChunk = Schema.Struct({ type: Schema.Literal("text-start"), id: Schema.String, ...withMetadata })
/** @since 0.1.0 */
export const TextDeltaChunk = Schema.Struct({
  type: Schema.Literal("text-delta"),
  id: Schema.String,
  delta: Schema.String,
  ...withMetadata,
})
/** @since 0.1.0 */
export const TextEndChunk = Schema.Struct({ type: Schema.Literal("text-end"), id: Schema.String, ...withMetadata })
/** @since 0.1.0 */
export const ReasoningStartChunk = Schema.Struct({ type: Schema.Literal("reasoning-start"), id: Schema.String, ...withMetadata })
/** @since 0.1.0 */
export const ReasoningDeltaChunk = Schema.Struct({
  type: Schema.Literal("reasoning-delta"),
  id: Schema.String,
  delta: Schema.String,
  ...withMetadata,
})
/** @since 0.1.0 */
export const ReasoningEndChunk = Schema.Struct({ type: Schema.Literal("reasoning-end"), id: Schema.String, ...withMetadata })
/** @since 0.1.0 */
export const ErrorChunk = Schema.Struct({ type: Schema.Literal("error"), errorText: Schema.String })

const toolCall = {
  toolCallId: Schema.String,
  providerExecuted: Schema.optionalKey(Schema.Boolean),
  dynamic: Schema.optionalKey(Schema.Boolean),
}

/** @since 0.1.0 */
export const ToolInputStartChunk = Schema.Struct({
  type: Schema.Literal("tool-input-start"),
  ...toolCall,
  toolName: Schema.String,
  ...withMetadata,
})
/** @since 0.1.0 */
export const ToolInputDeltaChunk = Schema.Struct({
  type: Schema.Literal("tool-input-delta"),
  toolCallId: Schema.String,
  inputTextDelta: Schema.String,
})

/** A typed chunk is never `dynamic`: `dynamic` is the discriminant against the dynamic variant. */
const staticCall = {
  toolCallId: Schema.String,
  providerExecuted: Schema.optionalKey(Schema.Boolean),
  dynamic: Schema.optionalKey(Schema.Literal(false)),
}

/**
 * `tool-input-available` for one tool: `toolName` is the literal, `input` its encoded parameters.
 *
 * @since 0.1.0
 */
export const ToolInputAvailableChunk = <const Name extends string, Parameters extends Schema.Top>(name: Name, parameters: Parameters) =>
  Schema.Struct({
    type: Schema.Literal("tool-input-available"),
    ...staticCall,
    toolName: Schema.Literal(name),
    input: Schema.toEncoded(parameters),
    ...withMetadata,
  })

/**
 * `tool-input-available` for a tool the toolkit does not know. `dynamic` is set.
 *
 * @since 0.1.0
 */
export const DynamicToolInputAvailableChunk = Schema.Struct({
  type: Schema.Literal("tool-input-available"),
  toolCallId: Schema.String,
  providerExecuted: Schema.optionalKey(Schema.Boolean),
  dynamic: Schema.Literal(true),
  toolName: Schema.String,
  input: Schema.Unknown,
  ...withMetadata,
})

/** @since 0.1.0 */
export const ToolInputErrorChunk = Schema.Struct({
  type: Schema.Literal("tool-input-error"),
  ...toolCall,
  toolName: Schema.String,
  input: Schema.Unknown,
  errorText: Schema.String,
  ...withMetadata,
})
/** @since 0.1.0 */
export const ToolApprovalRequestChunk = Schema.Struct({
  type: Schema.Literal("tool-approval-request"),
  approvalId: Schema.String,
  toolCallId: Schema.String,
})
/** @since 0.1.0 */
export const ToolApprovalResponseChunk = Schema.Struct({
  type: Schema.Literal("tool-approval-response"),
  approvalId: Schema.String,
  approved: Schema.Boolean,
  reason: Schema.optionalKey(Schema.String),
})

/**
 * `tool-output-available`: `output` is one of the toolkit's encoded successes.
 *
 * @since 0.1.0
 */
export const ToolOutputAvailableChunk = <Output extends Schema.Top>(output: Output) =>
  Schema.Struct({
    type: Schema.Literal("tool-output-available"),
    ...staticCall,
    output,
    preliminary: Schema.optionalKey(Schema.Boolean),
    ...withMetadata,
  })

/**
 * `tool-output-available` for a dynamic call: `output` is anything.
 *
 * @since 0.1.0
 */
export const DynamicToolOutputAvailableChunk = Schema.Struct({
  type: Schema.Literal("tool-output-available"),
  toolCallId: Schema.String,
  providerExecuted: Schema.optionalKey(Schema.Boolean),
  dynamic: Schema.Literal(true),
  output: Schema.Unknown,
  preliminary: Schema.optionalKey(Schema.Boolean),
  ...withMetadata,
})

/** @since 0.1.0 */
export const ToolOutputErrorChunk = Schema.Struct({
  type: Schema.Literal("tool-output-error"),
  ...toolCall,
  errorText: Schema.String,
  ...withMetadata,
})
/** @since 0.1.0 */
export const ToolOutputDeniedChunk = Schema.Struct({ type: Schema.Literal("tool-output-denied"), toolCallId: Schema.String })

/** @since 0.1.0 */
export const SourceUrlChunk = Schema.Struct({
  type: Schema.Literal("source-url"),
  sourceId: Schema.String,
  url: Schema.String,
  title: Schema.optionalKey(Schema.String),
  ...withMetadata,
})
/** @since 0.1.0 */
export const SourceDocumentChunk = Schema.Struct({
  type: Schema.Literal("source-document"),
  sourceId: Schema.String,
  mediaType: Schema.String,
  title: Schema.String,
  filename: Schema.optionalKey(Schema.String),
  ...withMetadata,
})
/** @since 0.1.0 */
export const FileChunk = Schema.Struct({ type: Schema.Literal("file"), url: Schema.String, mediaType: Schema.String, ...withMetadata })

/** @since 0.1.0 */
export const StartStepChunk = Schema.Struct({ type: Schema.Literal("start-step") })
/** @since 0.1.0 */
export const FinishStepChunk = Schema.Struct({ type: Schema.Literal("finish-step") })
/** @since 0.1.0 */
export const StartChunk = Schema.Struct({ type: Schema.Literal("start"), messageId: Schema.optionalKey(Schema.String) })

/**
 * The AI SDK finish reasons. Effect's `pause` and `unknown` map to `other`.
 *
 * @since 0.1.0
 */
export const FinishReason = Schema.Literals(["stop", "length", "content-filter", "tool-calls", "error", "other"])

/** @since 0.1.0 */
export type FinishReason = typeof FinishReason.Type

/** @since 0.1.0 */
export const FinishChunk = Schema.Struct({ type: Schema.Literal("finish"), finishReason: Schema.optionalKey(FinishReason) })
/** @since 0.1.0 */
export const AbortChunk = Schema.Struct({ type: Schema.Literal("abort"), reason: Schema.optionalKey(Schema.String) })

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/** @since 0.1.0 */
export type ToolInputAvailableChunk<Name extends string, Input> = {
  readonly type: "tool-input-available"
  readonly toolCallId: string
  readonly toolName: Name
  readonly input: Input
  readonly providerExecuted?: boolean
  readonly dynamic?: false
  readonly providerMetadata?: ProviderMetadata
}

/** @since 0.1.0 */
export type ToolInputAvailableChunks<Tools extends Record<string, Tool.Any>> = {
  [Name in keyof Tools & string]: ToolInputAvailableChunk<Name, Tool.ParametersEncoded<Tools[Name]>>
}[keyof Tools & string]

/** @since 0.1.0 */
export type ToolOutputs<Tools extends Record<string, Tool.Any>> = { [Name in keyof Tools]: Tool.SuccessEncoded<Tools[Name]> }[keyof Tools]

/** @since 0.1.0 */
export type ToolOutputAvailableChunk<Output> = {
  readonly type: "tool-output-available"
  readonly toolCallId: string
  readonly output: Output
  readonly providerExecuted?: boolean
  readonly dynamic?: false
  readonly preliminary?: boolean
  readonly providerMetadata?: ProviderMetadata
}

/** @since 0.1.0 */
export type UIMessageChunk<Tools extends Record<string, Tool.Any>> =
  | typeof TextStartChunk.Type
  | typeof TextDeltaChunk.Type
  | typeof TextEndChunk.Type
  | typeof ReasoningStartChunk.Type
  | typeof ReasoningDeltaChunk.Type
  | typeof ReasoningEndChunk.Type
  | typeof ErrorChunk.Type
  | typeof ToolInputStartChunk.Type
  | typeof ToolInputDeltaChunk.Type
  | ToolInputAvailableChunks<Tools>
  | typeof DynamicToolInputAvailableChunk.Type
  | typeof ToolInputErrorChunk.Type
  | typeof ToolApprovalRequestChunk.Type
  | typeof ToolApprovalResponseChunk.Type
  | ToolOutputAvailableChunk<ToolOutputs<Tools>>
  | typeof DynamicToolOutputAvailableChunk.Type
  | typeof ToolOutputErrorChunk.Type
  | typeof ToolOutputDeniedChunk.Type
  | typeof SourceUrlChunk.Type
  | typeof SourceDocumentChunk.Type
  | typeof FileChunk.Type
  | typeof StartStepChunk.Type
  | typeof FinishStepChunk.Type
  | typeof StartChunk.Type
  | typeof FinishChunk.Type
  | typeof AbortChunk.Type

/**
 * The chunk schema for a toolkit. Mirrors `Response.StreamPart(toolkit)`.
 *
 * @since 0.1.0
 */
export const UIMessageChunk = <T extends Toolkit.Any>(toolkit: T): Schema.Codec<UIMessageChunk<ToolsOf<T>>> => {
  const tools = Object.values(toolkit.tools).filter((tool) => !Tool.isDynamic(tool))
  const inputs = tools.map((tool) => ToolInputAvailableChunk(tool.name, tool.parametersSchema))
  const outputs = Schema.Union(tools.map((tool) => Schema.toEncoded(tool.successSchema)))
  return Schema.Union([
    TextStartChunk,
    TextDeltaChunk,
    TextEndChunk,
    ReasoningStartChunk,
    ReasoningDeltaChunk,
    ReasoningEndChunk,
    ErrorChunk,
    ToolInputStartChunk,
    ToolInputDeltaChunk,
    ...inputs,
    DynamicToolInputAvailableChunk,
    ToolInputErrorChunk,
    ToolApprovalRequestChunk,
    ToolApprovalResponseChunk,
    ToolOutputAvailableChunk(outputs),
    DynamicToolOutputAvailableChunk,
    ToolOutputErrorChunk,
    ToolOutputDeniedChunk,
    SourceUrlChunk,
    SourceDocumentChunk,
    FileChunk,
    StartStepChunk,
    FinishStepChunk,
    StartChunk,
    FinishChunk,
    AbortChunk,
  ]).annotate({ identifier: "UIMessageChunk" }) as any
}
