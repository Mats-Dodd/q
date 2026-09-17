import { Effect, Option, Result, Stream } from "effect"
import type { Tool } from "effect/unstable/ai"

import { isDynamicToolUIPart, isToolUIPart } from "./ui-message"
import type { AnyToolUIPart, ApprovalResponded, UIMessage, UIMessagePart } from "./ui-message"
import type { UIMessageChunk } from "./ui-message-chunk"
import { UIMessageStreamError } from "./ui-message-stream-error"

/**
 * The reducer: `applyChunk` folds one chunk into a `UIMessage`. It is the AI SDK's
 * `processUIMessageStream`, pure and total: the message is the whole state, and a chunk that fits
 * nothing is a `UIMessageStreamError` in a `Result`, not a throw.
 *
 * One reducer serves both sides. A server folds the chunks it streams; a client folds the chunks it
 * receives; both get the same message.
 *
 * @since 0.1.0
 */

type AnyTools = Record<string, Tool.Any>
type Message = UIMessage<AnyTools>
type Part = UIMessagePart<AnyTools>
type ToolPart = AnyToolUIPart<AnyTools>
type TextPart = Extract<Part, { type: "text" | "reasoning" }>
type Chunk = UIMessageChunk<AnyTools>

/**
 * An assistant message with no parts yet: what a stream is folded into.
 *
 * @since 0.1.0
 */
export const emptyAssistant = <Tools extends AnyTools>(id: string): UIMessage<Tools> => ({ id, role: "assistant", parts: [] })

const fail = (chunkType: string, chunkId: string, description: string) =>
  Result.fail(UIMessageStreamError.make({ chunkType, chunkId, description }))

const withParts = (message: Message, parts: ReadonlyArray<Part>): Message => ({ ...message, parts })

const push = (message: Message, part: Part): Message => withParts(message, [...message.parts, part])

const replace = (message: Message, index: number, part: Part): Message =>
  withParts(
    message,
    message.parts.map((existing, i) => (i === index ? part : existing)),
  )

interface Found<P extends Part> {
  readonly index: number
  readonly part: P
}

/** The last part the guard accepts, with its index. */
const findLast = <P extends Part>(parts: ReadonlyArray<Part>, guard: (part: Part) => part is P): Found<P> | undefined => {
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index]
    if (part !== undefined && guard(part)) {
      return { index, part }
    }
  }
  return undefined
}

const isStreaming =
  (kind: "text" | "reasoning", id: string) =>
  (part: Part): part is TextPart =>
    part.type === kind && part.id === id && part.state === "streaming"

const isCall =
  (toolCallId: string) =>
  (part: Part): part is ToolPart =>
    isToolUIPart(part) && part.toolCallId === toolCallId

const isApproval =
  (approvalId: string) =>
  (part: Part): part is ToolPart =>
    isToolUIPart(part) && "approval" in part && part.approval.id === approvalId

// The parts below are built from loose pieces (`tool-${string}` or `dynamic-tool`, optional
// `toolName`), which TypeScript cannot match to one union member. They are cast once, here.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the one place a loose tool part is trusted
const asToolPart = (part: object): ToolPart => part as ToolPart

/** The fields every state of a tool part keeps: its identity, plus what the call carried. */
const identity = (part: ToolPart) => ({
  type: part.type,
  toolCallId: part.toolCallId,
  ...(isDynamicToolUIPart(part) ? { toolName: part.toolName } : {}),
  ...(part.providerExecuted === undefined ? {} : { providerExecuted: part.providerExecuted }),
  ...("callProviderMetadata" in part ? { callProviderMetadata: part.callProviderMetadata } : {}),
})

const inputOf = (part: ToolPart): unknown => ("input" in part ? part.input : undefined)

const approvalOf = (part: ToolPart): ApprovalResponded | undefined =>
  "approval" in part && "approved" in part.approval ? part.approval : undefined

const granted = (part: ToolPart) => {
  const approval = approvalOf(part)
  return approval?.approved === true ? { approval: { ...approval, approved: true as const } } : {}
}

const applyLoose = (message: Message, chunk: Chunk): Result.Result<Message, UIMessageStreamError> => {
  switch (chunk.type) {
    case "text-start":
    case "reasoning-start": {
      const kind = chunk.type === "text-start" ? "text" : "reasoning"
      return Result.succeed(
        push(message, {
          type: kind,
          id: chunk.id,
          text: "",
          state: "streaming",
          ...(chunk.providerMetadata === undefined ? {} : { providerMetadata: chunk.providerMetadata }),
        }),
      )
    }
    case "text-delta":
    case "reasoning-delta": {
      const kind = chunk.type === "text-delta" ? "text" : "reasoning"
      const found = findLast(message.parts, isStreaming(kind, chunk.id))
      if (found === undefined) {
        return fail(chunk.type, chunk.id, `no streaming ${kind} part with this id; a ${kind}-start must come first`)
      }
      return Result.succeed(
        replace(message, found.index, {
          ...found.part,
          text: found.part.text + chunk.delta,
          ...(chunk.providerMetadata === undefined ? {} : { providerMetadata: chunk.providerMetadata }),
        }),
      )
    }
    case "text-end":
    case "reasoning-end": {
      const kind = chunk.type === "text-end" ? "text" : "reasoning"
      const found = findLast(message.parts, isStreaming(kind, chunk.id))
      if (found === undefined) {
        return fail(chunk.type, chunk.id, `no streaming ${kind} part with this id; a ${kind}-start must come first`)
      }
      return Result.succeed(
        replace(message, found.index, {
          ...found.part,
          state: "done",
          ...(chunk.providerMetadata === undefined ? {} : { providerMetadata: chunk.providerMetadata }),
        }),
      )
    }

    case "tool-input-start": {
      const part = asToolPart({
        ...(chunk.dynamic === true ? { type: "dynamic-tool", toolName: chunk.toolName } : { type: `tool-${chunk.toolName}` }),
        toolCallId: chunk.toolCallId,
        state: "input-streaming",
        ...(chunk.providerExecuted === undefined ? {} : { providerExecuted: chunk.providerExecuted }),
      })
      return Result.succeed(push(message, part))
    }
    case "tool-input-delta": {
      // Partial JSON is not parsed: the part stays `input-streaming` until the input is available.
      return findLast(message.parts, isCall(chunk.toolCallId)) === undefined
        ? fail(chunk.type, chunk.toolCallId, "no tool part with this call id; a tool-input-start must come first")
        : Result.succeed(message)
    }
    case "tool-input-available":
    case "tool-input-error": {
      const found = findLast(message.parts, isCall(chunk.toolCallId))
      const call = {
        toolCallId: chunk.toolCallId,
        ...(chunk.providerExecuted === undefined ? {} : { providerExecuted: chunk.providerExecuted }),
        ...(chunk.providerMetadata === undefined ? {} : { callProviderMetadata: chunk.providerMetadata }),
      }
      const fresh =
        chunk.dynamic === true
          ? { type: "dynamic-tool" as const, toolName: chunk.toolName, ...call }
          : { type: `tool-${chunk.toolName}` as const, ...call }
      const head = found === undefined ? fresh : { ...identity(found.part), ...call }
      const part = asToolPart(
        chunk.type === "tool-input-available"
          ? { ...head, state: "input-available", input: chunk.input }
          : { ...head, state: "output-error", input: chunk.input, errorText: chunk.errorText },
      )
      return Result.succeed(found === undefined ? push(message, part) : replace(message, found.index, part))
    }
    case "tool-approval-request": {
      const found = findLast(message.parts, isCall(chunk.toolCallId))
      if (found === undefined) {
        return fail(chunk.type, chunk.toolCallId, "no tool part with this call id")
      }
      const part = found.part
      if (part.state !== "input-available") {
        return fail(chunk.type, chunk.toolCallId, `the tool part is ${part.state}, not input-available`)
      }
      return Result.succeed(
        replace(
          message,
          found.index,
          asToolPart({ ...identity(part), state: "approval-requested", input: part.input, approval: { id: chunk.approvalId } }),
        ),
      )
    }
    case "tool-approval-response": {
      const found = findLast(message.parts, isApproval(chunk.approvalId))
      if (found === undefined) {
        return fail(chunk.type, chunk.approvalId, "no tool part with this approval id")
      }
      const part = found.part
      if (part.state !== "approval-requested") {
        return fail(chunk.type, chunk.approvalId, `the tool part is ${part.state}, not approval-requested`)
      }
      return Result.succeed(
        replace(
          message,
          found.index,
          asToolPart({
            ...identity(part),
            state: "approval-responded",
            input: part.input,
            approval: { id: chunk.approvalId, approved: chunk.approved, ...(chunk.reason === undefined ? {} : { reason: chunk.reason }) },
          }),
        ),
      )
    }
    case "tool-output-available": {
      const found = findLast(message.parts, isCall(chunk.toolCallId))
      if (found === undefined) {
        return fail(chunk.type, chunk.toolCallId, "no tool part with this call id")
      }
      return Result.succeed(
        replace(
          message,
          found.index,
          asToolPart({
            ...identity(found.part),
            state: "output-available",
            input: inputOf(found.part),
            output: chunk.output,
            ...(chunk.preliminary === true ? { preliminary: true } : {}),
            ...granted(found.part),
          }),
        ),
      )
    }
    case "tool-output-error": {
      const found = findLast(message.parts, isCall(chunk.toolCallId))
      if (found === undefined) {
        return fail(chunk.type, chunk.toolCallId, "no tool part with this call id")
      }
      return Result.succeed(
        replace(
          message,
          found.index,
          asToolPart({
            ...identity(found.part),
            state: "output-error",
            input: inputOf(found.part),
            errorText: chunk.errorText,
            ...granted(found.part),
          }),
        ),
      )
    }
    case "tool-output-denied": {
      const found = findLast(message.parts, isCall(chunk.toolCallId))
      if (found === undefined) {
        return fail(chunk.type, chunk.toolCallId, "no tool part with this call id")
      }
      const approval = approvalOf(found.part)
      return Result.succeed(
        replace(
          message,
          found.index,
          asToolPart({
            ...identity(found.part),
            state: "output-denied",
            input: inputOf(found.part),
            approval: { id: approval?.id ?? "", approved: false, ...(approval?.reason === undefined ? {} : { reason: approval.reason }) },
          }),
        ),
      )
    }

    case "source-url": {
      return Result.succeed(
        push(message, {
          type: "source-url",
          sourceId: chunk.sourceId,
          url: chunk.url,
          ...(chunk.title === undefined ? {} : { title: chunk.title }),
          ...(chunk.providerMetadata === undefined ? {} : { providerMetadata: chunk.providerMetadata }),
        }),
      )
    }
    case "source-document": {
      return Result.succeed(
        push(message, {
          type: "source-document",
          sourceId: chunk.sourceId,
          mediaType: chunk.mediaType,
          title: chunk.title,
          ...(chunk.filename === undefined ? {} : { filename: chunk.filename }),
          ...(chunk.providerMetadata === undefined ? {} : { providerMetadata: chunk.providerMetadata }),
        }),
      )
    }
    case "file": {
      return Result.succeed(
        push(message, {
          type: "file",
          mediaType: chunk.mediaType,
          url: chunk.url,
          ...(chunk.providerMetadata === undefined ? {} : { providerMetadata: chunk.providerMetadata }),
        }),
      )
    }

    case "start-step": {
      return Result.succeed(push(message, { type: "step-start" }))
    }
    case "start": {
      return Result.succeed(chunk.messageId === undefined ? message : { ...message, id: chunk.messageId })
    }
    // `error` is for the caller: the reducer has no place for it in the message.
    case "error":
    case "finish-step":
    case "finish":
    case "abort": {
      return Result.succeed(message)
    }
  }
}

/**
 * Fold one chunk into the message. The message is unchanged by reference for chunks that carry no
 * state (`finish-step`, `error`, ...).
 *
 * @since 0.1.0
 */
export const applyChunk = <Tools extends AnyTools>(
  message: UIMessage<Tools>,
  chunk: UIMessageChunk<Tools>,
): Result.Result<UIMessage<Tools>, UIMessageStreamError> =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the reducer is written once over erased Tools
  applyLoose(message, chunk) as Result.Result<UIMessage<Tools>, UIMessageStreamError>

/**
 * Close what is still open: every `streaming` text and reasoning part becomes `done`. For a stream
 * that ended early, by cancellation or failure.
 *
 * @since 0.1.0
 */
export const finalize = <Tools extends AnyTools>(message: UIMessage<Tools>): UIMessage<Tools> => {
  const loose: Message = message
  const streaming = (part: Part) => (part.type === "text" || part.type === "reasoning") && part.state === "streaming"
  if (!loose.parts.some(streaming)) {
    return message
  }
  const done = (part: Part): Part => (part.type === "text" || part.type === "reasoning" ? { ...part, state: "done" } : part)
  const closed = withParts(
    loose,
    loose.parts.map((part) => (streaming(part) ? done(part) : part)),
  )
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- parts only changed state; Tools is unchanged
  return closed as UIMessage<Tools>
}

/**
 * The message after each chunk: `Stream.scan` over `applyChunk`, without the initial value. Fails
 * with the first chunk that does not fit.
 *
 * @since 0.1.0
 */
export const readUIMessageStream = <Tools extends AnyTools, E, R>(
  stream: Stream.Stream<UIMessageChunk<Tools>, E, R>,
  initial: UIMessage<Tools>,
): Stream.Stream<UIMessage<Tools>, E | UIMessageStreamError, R> =>
  Stream.mapAccumEffect(
    stream,
    () => initial,
    (message, chunk) => {
      const next = applyChunk(message, chunk)
      return Result.isFailure(next) ? Effect.fail(next.failure) : Effect.succeed([next.success, [next.success]] as const)
    },
  )

/**
 * The message a whole chunk stream produces: `readUIMessageStream`, last value, finalized.
 *
 * @since 0.1.0
 */
export const foldUIMessageStream = <Tools extends AnyTools, E, R>(
  stream: Stream.Stream<UIMessageChunk<Tools>, E, R>,
  initial: UIMessage<Tools>,
): Effect.Effect<UIMessage<Tools>, E | UIMessageStreamError, R> =>
  Effect.map(Stream.runLast(readUIMessageStream(stream, initial)), (last) => finalize(Option.getOrElse(last, () => initial)))
