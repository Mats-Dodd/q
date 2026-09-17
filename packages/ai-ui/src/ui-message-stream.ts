import { Encoding, Filter, Option, Predicate, Result, Schema, Stream } from "effect"
import { Tool } from "effect/unstable/ai"
import type { Response, Toolkit } from "effect/unstable/ai"

import type { ProviderMetadata, ToolsOf } from "./ui-message"
import type { UIMessageChunk } from "./ui-message-chunk"

/**
 * The adapter: Effect `LanguageModel` stream parts in, AI SDK UI message chunks out.
 *
 * One `LanguageModel.streamText` call is one step. `toUIMessageStream` wraps it in `start-step` and
 * `finish-step`; the agent loop that calls the model again is the caller's, and so are `start` and
 * `finish` around the whole message.
 *
 * Tool calls arrive with opaque parameters (Effect decodes them only in the handler), so the adapter
 * checks them against the tool's encoded schema. Valid parameters are a typed `tool-input-available`;
 * invalid ones are a `tool-input-error`, as in the AI SDK; a tool the toolkit does not know is
 * `dynamic`.
 *
 * @since 0.1.0
 */

/**
 * Any part `LanguageModel.streamText` can produce, with tool parameters left opaque.
 *
 * @since 0.1.0
 */
export type AnyStreamPart = Response.StreamPart<Record<string, Tool.Any>, "opaque">

/** @since 0.1.0 */
export interface ToUIMessageStreamOptions {
  /** Forward reasoning parts. Default `true`. */
  readonly sendReasoning?: boolean
  /** Forward source parts. Default `false`. */
  readonly sendSources?: boolean
  /** The text of an `error` chunk for an `error` part. Default: a fixed message that leaks nothing. */
  readonly onError?: (error: unknown) => string
}

const metadata = (value: ProviderMetadata | undefined): { readonly providerMetadata?: ProviderMetadata } =>
  value !== undefined && Object.keys(value).length > 0 ? { providerMetadata: value } : {}

const executed = (value: boolean | undefined): { readonly providerExecuted?: boolean } => (value === true ? { providerExecuted: true } : {})

const isDenied = (result: unknown): boolean => Predicate.hasProperty(result, "type") && result.type === "execution-denied"

/** The lib types say `string`; `JSON.stringify(undefined)` is `undefined` at runtime. */
const stringify = (value: unknown): string | undefined => JSON.stringify(value)

/**
 * One line for a failed tool result: its `message` if it has one, the string itself, or its JSON.
 *
 * @since 0.1.0
 */
export const describeFailure = (result: unknown): string => {
  if (typeof result === "string") {
    return result
  }
  if (Predicate.hasProperty(result, "message") && typeof result.message === "string") {
    return result.message
  }
  return stringify(result) ?? String(result)
}

const toFinishReason = (reason: Response.FinishReason) => (reason === "pause" || reason === "unknown" ? "other" : reason)

/**
 * The chunk for one part, if the part has one. `finish` and `response-metadata` do not.
 *
 * @since 0.1.0
 */
export const toUIMessageChunk = <T extends Toolkit.Any>(toolkit: T, options: ToUIMessageStreamOptions = {}) => {
  const sendReasoning = options.sendReasoning ?? true
  const sendSources = options.sendSources ?? false
  const onError = options.onError ?? (() => "An error occurred.")
  const validators = new Map<string, (input: unknown) => Result.Result<unknown, Schema.SchemaError>>()
  const validate = (name: string, input: unknown): Result.Result<unknown, Schema.SchemaError> | undefined => {
    const tool = toolkit.tools[name]
    if (tool === undefined || Tool.isDynamic(tool)) {
      return undefined
    }
    let validator = validators.get(name)
    if (validator === undefined) {
      validator = Schema.decodeUnknownResult(Schema.toEncoded(tool.parametersSchema))
      validators.set(name, validator)
    }
    return validator(input)
  }
  const isKnown = (name: string) => {
    const tool = toolkit.tools[name]
    return tool !== undefined && !Tool.isDynamic(tool)
  }
  const dynamic = (name: string): { readonly dynamic?: true } => (isKnown(name) ? {} : { dynamic: true })

  const convert = (part: AnyStreamPart): UIMessageChunk<Record<string, Tool.Any>> | undefined => {
    switch (part.type) {
      case "text-start": {
        return { type: "text-start", id: part.id, ...metadata(part.metadata) }
      }
      case "text-delta": {
        return { type: "text-delta", id: part.id, delta: part.delta, ...metadata(part.metadata) }
      }
      case "text-end": {
        return { type: "text-end", id: part.id, ...metadata(part.metadata) }
      }
      case "reasoning-start": {
        return sendReasoning ? { type: "reasoning-start", id: part.id, ...metadata(part.metadata) } : undefined
      }
      case "reasoning-delta": {
        return sendReasoning ? { type: "reasoning-delta", id: part.id, delta: part.delta, ...metadata(part.metadata) } : undefined
      }
      case "reasoning-end": {
        return sendReasoning ? { type: "reasoning-end", id: part.id, ...metadata(part.metadata) } : undefined
      }
      case "tool-params-start": {
        return {
          type: "tool-input-start",
          toolCallId: part.id,
          toolName: part.name,
          ...executed(part.providerExecuted),
          ...dynamic(part.name),
          ...metadata(part.metadata),
        }
      }
      case "tool-params-delta": {
        return { type: "tool-input-delta", toolCallId: part.id, inputTextDelta: part.delta }
      }
      case "tool-params-end": {
        return undefined
      }
      case "tool-call": {
        const base = { toolCallId: part.id, toolName: part.name, ...executed(part.providerExecuted), ...metadata(part.metadata) }
        const checked = validate(part.name, part.params)
        if (checked === undefined) {
          return { type: "tool-input-available", ...base, dynamic: true, input: part.params }
        }
        return Result.isSuccess(checked)
          ? { type: "tool-input-available", ...base, input: part.params }
          : { type: "tool-input-error", ...base, input: part.params, errorText: checked.failure.message }
      }
      case "tool-result": {
        if (part.preliminary && part.isFailure) {
          return undefined
        }
        const base = { toolCallId: part.id, ...executed(part.providerExecuted), ...dynamic(part.name), ...metadata(part.metadata) }
        if (part.isFailure) {
          return isDenied(part.encodedResult)
            ? { type: "tool-output-denied", toolCallId: part.id }
            : { type: "tool-output-error", ...base, errorText: describeFailure(part.encodedResult) }
        }
        return { type: "tool-output-available", ...base, output: part.encodedResult, ...(part.preliminary ? { preliminary: true } : {}) }
      }
      case "tool-approval-request": {
        return { type: "tool-approval-request", approvalId: part.approvalId, toolCallId: part.toolCallId }
      }
      case "file": {
        return {
          type: "file",
          mediaType: part.mediaType,
          url: `data:${part.mediaType};base64,${Encoding.encodeBase64(part.data)}`,
          ...metadata(part.metadata),
        }
      }
      case "source": {
        if (!sendSources) {
          return undefined
        }
        return part.sourceType === "url"
          ? { type: "source-url", sourceId: part.id, url: part.url.toString(), title: part.title, ...metadata(part.metadata) }
          : {
              type: "source-document",
              sourceId: part.id,
              mediaType: part.mediaType,
              title: part.title,
              ...(part.fileName === undefined ? {} : { filename: part.fileName }),
              ...metadata(part.metadata),
            }
      }
      case "response-metadata": {
        return undefined
      }
      case "finish": {
        return undefined
      }
      case "error": {
        return { type: "error", errorText: onError(part.error) }
      }
    }
  }

  return (part: AnyStreamPart): Option.Option<UIMessageChunk<ToolsOf<T>>> => {
    const chunk = convert(part)
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- convert is written once over erased Tools
    return chunk === undefined ? Option.none() : Option.some(chunk as UIMessageChunk<ToolsOf<T>>)
  }
}

/**
 * One step as UI message chunks: `start-step`, the parts that have a chunk, `finish-step`. Stream
 * failures pass through untouched; an `error` part becomes an `error` chunk.
 *
 * @since 0.1.0
 */
export const toUIMessageStream =
  <T extends Toolkit.Any>(toolkit: T, options: ToUIMessageStreamOptions = {}) =>
  <E, R>(stream: Stream.Stream<AnyStreamPart, E, R>): Stream.Stream<UIMessageChunk<ToolsOf<T>>, E, R> => {
    const convert = toUIMessageChunk(toolkit, options)
    const startStep: UIMessageChunk<ToolsOf<T>> = { type: "start-step" }
    const finishStep: UIMessageChunk<ToolsOf<T>> = { type: "finish-step" }
    return Stream.make(startStep).pipe(
      Stream.concat(Stream.filterMap(stream, Filter.fromPredicateOption(convert))),
      Stream.concat(Stream.make(finishStep)),
    )
  }

/**
 * The AI SDK finish reason for an Effect one, for a `finish` chunk the caller emits.
 *
 * @since 0.1.0
 */
export const finishChunk = (reason: Response.FinishReason): UIMessageChunk<Record<string, Tool.Any>> => ({
  type: "finish",
  finishReason: toFinishReason(reason),
})
