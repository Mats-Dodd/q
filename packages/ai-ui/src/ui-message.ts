import { Schema } from "effect"
import { Tool, type Toolkit } from "effect/unstable/ai"

/**
 * The AI SDK UI message: what a client renders and what a server folds a stream into. Every field
 * is JSON, so a `UIMessage` crosses a wire, a database or a `useChat` boundary as it is.
 *
 * Tool parts are typed from a `Toolkit`, the way Effect types `Response.Part(toolkit)`: one
 * `tool-${name}` variant per tool, with `input` and `output` in the tool's encoded (JSON) form.
 *
 * Differences from the AI SDK, on purpose:
 * - Text parts carry an optional `id`. The reducer is pure over the message alone, so the part must
 *   remember which stream it belongs to. `useChat` ignores the field.
 * - `input-streaming` carries no partial `input`. Partial JSON is not parsed.
 * - No `metadata`, `data-*` or `custom` parts. Add them when something needs them.
 *
 * @since 0.1.0
 */

// -----------------------------------------------------------------------------
// Provider metadata
// -----------------------------------------------------------------------------

/**
 * Provider-specific metadata, keyed by provider. The same shape as Effect's `Response.ProviderMetadata`.
 *
 * @since 0.1.0
 */
export const ProviderMetadata = Schema.Record(Schema.String, Schema.NullOr(Schema.Json))

/** @since 0.1.0 */
export type ProviderMetadata = typeof ProviderMetadata.Type

// -----------------------------------------------------------------------------
// Content parts
// -----------------------------------------------------------------------------

/** @since 0.1.0 */
export const TextUIPart = Schema.Struct({
  type: Schema.Literal("text"),
  id: Schema.optionalKey(Schema.String),
  text: Schema.String,
  state: Schema.optionalKey(Schema.Literals(["streaming", "done"])),
  providerMetadata: Schema.optionalKey(ProviderMetadata),
}).annotate({ identifier: "TextUIPart" })

/** @since 0.1.0 */
export type TextUIPart = typeof TextUIPart.Type

/** @since 0.1.0 */
export const ReasoningUIPart = Schema.Struct({
  type: Schema.Literal("reasoning"),
  id: Schema.optionalKey(Schema.String),
  text: Schema.String,
  state: Schema.optionalKey(Schema.Literals(["streaming", "done"])),
  providerMetadata: Schema.optionalKey(ProviderMetadata),
}).annotate({ identifier: "ReasoningUIPart" })

/** @since 0.1.0 */
export type ReasoningUIPart = typeof ReasoningUIPart.Type

/**
 * A step boundary. One `start-step` chunk becomes one of these; a step is one round trip to the model.
 *
 * @since 0.1.0
 */
export const StepStartUIPart = Schema.Struct({ type: Schema.Literal("step-start") }).annotate({ identifier: "StepStartUIPart" })

/** @since 0.1.0 */
export type StepStartUIPart = typeof StepStartUIPart.Type

/** @since 0.1.0 */
export const FileUIPart = Schema.Struct({
  type: Schema.Literal("file"),
  mediaType: Schema.String,
  filename: Schema.optionalKey(Schema.String),
  url: Schema.String,
  providerMetadata: Schema.optionalKey(ProviderMetadata),
}).annotate({ identifier: "FileUIPart" })

/** @since 0.1.0 */
export type FileUIPart = typeof FileUIPart.Type

/** @since 0.1.0 */
export const SourceUrlUIPart = Schema.Struct({
  type: Schema.Literal("source-url"),
  sourceId: Schema.String,
  url: Schema.String,
  title: Schema.optionalKey(Schema.String),
  providerMetadata: Schema.optionalKey(ProviderMetadata),
}).annotate({ identifier: "SourceUrlUIPart" })

/** @since 0.1.0 */
export type SourceUrlUIPart = typeof SourceUrlUIPart.Type

/** @since 0.1.0 */
export const SourceDocumentUIPart = Schema.Struct({
  type: Schema.Literal("source-document"),
  sourceId: Schema.String,
  mediaType: Schema.String,
  title: Schema.String,
  filename: Schema.optionalKey(Schema.String),
  providerMetadata: Schema.optionalKey(ProviderMetadata),
}).annotate({ identifier: "SourceDocumentUIPart" })

/** @since 0.1.0 */
export type SourceDocumentUIPart = typeof SourceDocumentUIPart.Type

// -----------------------------------------------------------------------------
// Tool parts
// -----------------------------------------------------------------------------

/** @since 0.1.0 */
export const ToolState = Schema.Literals([
  "input-streaming",
  "input-available",
  "approval-requested",
  "approval-responded",
  "output-available",
  "output-error",
  "output-denied",
])

/** @since 0.1.0 */
export type ToolState = typeof ToolState.Type

/** @since 0.1.0 */
export const ApprovalRequested = Schema.Struct({ id: Schema.String })

/** @since 0.1.0 */
export type ApprovalRequested = typeof ApprovalRequested.Type

/** @since 0.1.0 */
export const ApprovalResponded = Schema.Struct({ id: Schema.String, approved: Schema.Boolean, reason: Schema.optionalKey(Schema.String) })

/** @since 0.1.0 */
export type ApprovalResponded = typeof ApprovalResponded.Type

const ApprovalGranted = Schema.Struct({ id: Schema.String, approved: Schema.Literal(true), reason: Schema.optionalKey(Schema.String) })
const ApprovalDenied = Schema.Struct({ id: Schema.String, approved: Schema.Literal(false), reason: Schema.optionalKey(Schema.String) })

/** @since 0.1.0 */
export type ApprovalGranted = typeof ApprovalGranted.Type

/** @since 0.1.0 */
export type ApprovalDenied = typeof ApprovalDenied.Type

/**
 * The fields every tool part has, in every state.
 *
 * @since 0.1.0
 */
export interface ToolUIPartBase<Type extends string> {
  readonly type: Type
  readonly toolCallId: string
  readonly providerExecuted?: boolean
}

/**
 * The state machine of one tool call. `Input` and `Output` are the tool's encoded types.
 *
 * @since 0.1.0
 */
export type ToolUIPartStates<Type extends string, Input, Output> =
  | (ToolUIPartBase<Type> & { readonly state: "input-streaming" })
  | (ToolUIPartBase<Type> & { readonly state: "input-available"; readonly input: Input; readonly callProviderMetadata?: ProviderMetadata })
  | (ToolUIPartBase<Type> & {
      readonly state: "approval-requested"
      readonly input: Input
      readonly callProviderMetadata?: ProviderMetadata
      readonly approval: ApprovalRequested
    })
  | (ToolUIPartBase<Type> & {
      readonly state: "approval-responded"
      readonly input: Input
      readonly callProviderMetadata?: ProviderMetadata
      readonly approval: ApprovalResponded
    })
  | (ToolUIPartBase<Type> & {
      readonly state: "output-available"
      readonly input: Input
      readonly output: Output
      readonly callProviderMetadata?: ProviderMetadata
      readonly preliminary?: boolean
      readonly approval?: ApprovalGranted
    })
  | (ToolUIPartBase<Type> & {
      readonly state: "output-error"
      readonly input: unknown
      readonly errorText: string
      readonly callProviderMetadata?: ProviderMetadata
      readonly approval?: ApprovalGranted
    })
  | (ToolUIPartBase<Type> & {
      readonly state: "output-denied"
      readonly input: Input
      readonly callProviderMetadata?: ProviderMetadata
      readonly approval: ApprovalDenied
    })

/**
 * The part for one tool of a toolkit: `type` is `tool-${name}`.
 *
 * @since 0.1.0
 */
export type ToolUIPart<Name extends string, Input, Output> = ToolUIPartStates<`tool-${Name}`, Input, Output>

/**
 * The part for a tool the toolkit does not know: `Tool.Dynamic`, or a name the model made up.
 *
 * @since 0.1.0
 */
export type DynamicToolUIPart = ToolUIPartStates<"dynamic-tool", unknown, unknown> & { readonly toolName: string }

const toolStates = <const Base extends Schema.Struct.Fields, Input extends Schema.Top, Output extends Schema.Top>(
  base: Base,
  input: Input,
  output: Output,
) => {
  const call = { callProviderMetadata: Schema.optionalKey(ProviderMetadata) }
  return Schema.Union([
    Schema.Struct({ ...base, state: Schema.Literal("input-streaming") }),
    Schema.Struct({ ...base, ...call, state: Schema.Literal("input-available"), input }),
    Schema.Struct({ ...base, ...call, state: Schema.Literal("approval-requested"), input, approval: ApprovalRequested }),
    Schema.Struct({ ...base, ...call, state: Schema.Literal("approval-responded"), input, approval: ApprovalResponded }),
    Schema.Struct({
      ...base,
      ...call,
      state: Schema.Literal("output-available"),
      input,
      output,
      preliminary: Schema.optionalKey(Schema.Boolean),
      approval: Schema.optionalKey(ApprovalGranted),
    }),
    Schema.Struct({
      ...base,
      ...call,
      state: Schema.Literal("output-error"),
      input: Schema.Unknown,
      errorText: Schema.String,
      approval: Schema.optionalKey(ApprovalGranted),
    }),
    Schema.Struct({ ...base, ...call, state: Schema.Literal("output-denied"), input, approval: ApprovalDenied }),
  ])
}

const toolBase = { toolCallId: Schema.String, providerExecuted: Schema.optionalKey(Schema.Boolean) }

/**
 * The schema for one tool's part, from its name, parameters schema and success schema. `input` is
 * `Schema.toEncoded(parameters)`, `output` is `Schema.toEncoded(success)`: the JSON the wire carries.
 *
 * @since 0.1.0
 */
export const ToolUIPart = <const Name extends string, Parameters extends Schema.Top, Success extends Schema.Top>(
  name: Name,
  parameters: Parameters,
  success: Success,
): Schema.Codec<ToolUIPart<Name, Parameters["Encoded"], Success["Encoded"]>> =>
  toolStates({ ...toolBase, type: Schema.Literal(`tool-${name}`) }, Schema.toEncoded(parameters), Schema.toEncoded(success)).annotate({
    identifier: `ToolUIPart(${name})`,
  }) as any

/** @since 0.1.0 */
export const DynamicToolUIPart: Schema.Codec<DynamicToolUIPart> = toolStates(
  { ...toolBase, type: Schema.Literal("dynamic-tool"), toolName: Schema.String },
  Schema.Unknown,
  Schema.Unknown,
).annotate({ identifier: "DynamicToolUIPart" }) as any

/**
 * The tool parts of a toolkit, one union member per tool. Mirrors `Response.ToolCallParts<Tools>`.
 *
 * @since 0.1.0
 */
export type ToolUIParts<Tools extends Record<string, Tool.Any>> = {
  [Name in keyof Tools & string]: ToolUIPart<Name, Tool.ParametersEncoded<Tools[Name]>, Tool.SuccessEncoded<Tools[Name]>>
}[keyof Tools & string]

/**
 * A `tool-*` or `dynamic-tool` part, in any state.
 *
 * @since 0.1.0
 */
export type AnyToolUIPart<Tools extends Record<string, Tool.Any>> = ToolUIParts<Tools> | DynamicToolUIPart

/**
 * Every tool of a toolkit, as `ToolUIPart` schemas. Dynamic tools are covered by `DynamicToolUIPart`.
 *
 * @since 0.1.0
 */
export const toolUIParts = (toolkit: Toolkit.Any): ReadonlyArray<Schema.Top> =>
  Object.values(toolkit.tools)
    .filter((tool) => !Tool.isDynamic(tool))
    .map((tool) => ToolUIPart(tool.name, tool.parametersSchema, tool.successSchema))

// -----------------------------------------------------------------------------
// The message
// -----------------------------------------------------------------------------

/** @since 0.1.0 */
export type UIMessagePart<Tools extends Record<string, Tool.Any>> =
  | TextUIPart
  | ReasoningUIPart
  | StepStartUIPart
  | FileUIPart
  | SourceUrlUIPart
  | SourceDocumentUIPart
  | AnyToolUIPart<Tools>

/** @since 0.1.0 */
export const Role = Schema.Literals(["system", "user", "assistant"])

/** @since 0.1.0 */
export type Role = typeof Role.Type

/** @since 0.1.0 */
export interface UIMessage<Tools extends Record<string, Tool.Any>> {
  readonly id: string
  readonly role: Role
  readonly parts: ReadonlyArray<UIMessagePart<Tools>>
}

/**
 * The tools of a toolkit, as a record. `Toolkit.Tools<T>` for a `Toolkit`; the loose record for `Toolkit.Any`.
 *
 * @since 0.1.0
 */
export type ToolsOf<T extends Toolkit.Any> = T extends Toolkit.Toolkit<infer Tools> ? Tools : Record<string, Tool.Any>

/**
 * The schema of one message part for a toolkit. Mirrors `Response.StreamPart(toolkit)`.
 *
 * @since 0.1.0
 */
export const UIMessagePart = <T extends Toolkit.Any>(toolkit: T): Schema.Codec<UIMessagePart<ToolsOf<T>>> =>
  Schema.Union([
    TextUIPart,
    ReasoningUIPart,
    StepStartUIPart,
    FileUIPart,
    SourceUrlUIPart,
    SourceDocumentUIPart,
    DynamicToolUIPart,
    ...toolUIParts(toolkit),
  ]).annotate({ identifier: "UIMessagePart" }) as any

/**
 * The schema of a message for a toolkit.
 *
 * @since 0.1.0
 */
export const UIMessage = <T extends Toolkit.Any>(toolkit: T): Schema.Codec<UIMessage<ToolsOf<T>>> =>
  Schema.Struct({ id: Schema.String, role: Role, parts: Schema.Array(UIMessagePart(toolkit)) }).annotate({ identifier: "UIMessage" }) as any

// -----------------------------------------------------------------------------
// Guards
// -----------------------------------------------------------------------------

/**
 * Is this part a tool part, static or dynamic?
 *
 * @since 0.1.0
 */
export const isToolUIPart = <Tools extends Record<string, Tool.Any>>(part: UIMessagePart<Tools>): part is AnyToolUIPart<Tools> =>
  part.type === "dynamic-tool" || part.type.startsWith("tool-")

/**
 * Is this tool part for a tool the toolkit does not know?
 *
 * @since 0.1.0
 */
export const isDynamicToolUIPart = <Tools extends Record<string, Tool.Any>>(part: AnyToolUIPart<Tools>): part is DynamicToolUIPart =>
  part.type === "dynamic-tool"

/**
 * The tool's name: the `toolName` of a dynamic part, the suffix of `tool-${name}` otherwise.
 *
 * @since 0.1.0
 */
export const getToolName = <Tools extends Record<string, Tool.Any>>(part: AnyToolUIPart<Tools>): string =>
  isDynamicToolUIPart(part) ? part.toolName : part.type.slice("tool-".length)
