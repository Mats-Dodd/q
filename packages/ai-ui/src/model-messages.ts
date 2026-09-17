import { Prompt } from "effect/unstable/ai"
import type { Tool } from "effect/unstable/ai"

import { getToolName, isToolUIPart } from "./ui-message"
import type { AnyToolUIPart, FileUIPart, UIMessage, UIMessagePart } from "./ui-message"

/**
 * `UIMessage[]` to `Prompt.Prompt`: the AI SDK's `convertToModelMessages`, for Effect's prompt.
 *
 * An assistant message is split at its `step-start` parts; each step becomes one assistant message
 * and, when it called tools, one tool message with the results. That is the shape the providers
 * expect and the shape `Prompt.fromResponseParts` produces for one step.
 *
 * Incomplete tool calls (`input-streaming`, `input-available`, `approval-requested`) are dropped:
 * a provider rejects a call with no result. A denied approval (`approval-responded`, not approved)
 * carries only the response; Effect's `LanguageModel` writes the denial result itself.
 *
 * @since 0.1.0
 */

type AnyTools = Record<string, Tool.Any>
type Part = UIMessagePart<AnyTools>
type ToolPart = AnyToolUIPart<AnyTools>

const options = (metadata: Prompt.ProviderOptions | undefined) => (metadata === undefined ? {} : { options: metadata })

type CompleteToolPart = Extract<ToolPart, { readonly state: "approval-responded" | "output-available" | "output-error" | "output-denied" }>

const isComplete = (part: ToolPart): part is CompleteToolPart =>
  part.state === "approval-responded" ||
  (part.state === "output-available" && part.preliminary !== true) ||
  part.state === "output-error" ||
  part.state === "output-denied"

const filePart = (part: FileUIPart): Prompt.FilePart => {
  const data = part.url.startsWith("data:") ? part.url.slice(part.url.indexOf(",") + 1) : new URL(part.url)
  return Prompt.makePart("file", {
    mediaType: part.mediaType,
    data,
    ...(part.filename === undefined ? {} : { fileName: part.filename }),
    ...options(part.providerMetadata),
  })
}

const toolResult = (part: ToolPart, isFailure: boolean, result: unknown): Prompt.ToolResultPart =>
  Prompt.makePart("tool-result", {
    id: part.toolCallId,
    name: getToolName(part),
    isFailure,
    result,
    providerExecuted: part.providerExecuted ?? false,
    ...options("callProviderMetadata" in part ? part.callProviderMetadata : undefined),
  })

const assistantStep = (block: ReadonlyArray<Part>): ReadonlyArray<Prompt.Message> => {
  const content: Array<Prompt.AssistantMessagePart> = []
  const results: Array<Prompt.ToolMessagePart> = []

  for (const part of block) {
    switch (part.type) {
      case "text": {
        content.push(Prompt.makePart("text", { text: part.text, ...options(part.providerMetadata) }))
        break
      }
      case "reasoning": {
        content.push(Prompt.makePart("reasoning", { text: part.text, ...options(part.providerMetadata) }))
        break
      }
      case "file": {
        content.push(filePart(part))
        break
      }
      case "step-start":
      case "source-url":
      case "source-document": {
        break
      }
      default: {
        if (!isToolUIPart(part) || !isComplete(part)) {
          break
        }
        content.push(
          Prompt.makePart("tool-call", {
            id: part.toolCallId,
            name: getToolName(part),
            params: part.input,
            providerExecuted: part.providerExecuted ?? false,
            ...options(part.callProviderMetadata),
          }),
        )
        const approval = "approval" in part ? part.approval : undefined
        if (approval !== undefined) {
          content.push(Prompt.makePart("tool-approval-request", { approvalId: approval.id, toolCallId: part.toolCallId }))
        }
        if (part.providerExecuted === true && (part.state === "output-available" || part.state === "output-error")) {
          content.push(toolResult(part, part.state === "output-error", part.state === "output-error" ? part.errorText : part.output))
        }
        // The tool message: what the client executed, and what the user decided.
        if (part.providerExecuted === true && approval === undefined) {
          break
        }
        if (approval !== undefined) {
          results.push(
            Prompt.makePart("tool-approval-response", { approvalId: approval.id, approved: approval.approved, reason: approval.reason }),
          )
        }
        if (part.providerExecuted === true) {
          break
        }
        switch (part.state) {
          case "output-available": {
            results.push(toolResult(part, false, part.output))
            break
          }
          case "output-error": {
            results.push(toolResult(part, true, part.errorText))
            break
          }
          case "output-denied": {
            results.push(toolResult(part, true, { type: "execution-denied", reason: part.approval.reason }))
            break
          }
          case "approval-responded": {
            break
          }
        }
      }
    }
  }

  const messages: Array<Prompt.Message> = []
  if (content.length > 0) {
    messages.push(Prompt.makeMessage("assistant", { content }))
  }
  if (results.length > 0) {
    messages.push(Prompt.makeMessage("tool", { content: results }))
  }
  return messages
}

const steps = (parts: ReadonlyArray<Part>): ReadonlyArray<ReadonlyArray<Part>> => {
  const blocks: Array<Array<Part>> = []
  let current: Array<Part> = []
  blocks.push(current)
  for (const part of parts) {
    if (part.type === "step-start") {
      if (current.length > 0) {
        current = []
        blocks.push(current)
      }
    } else {
      current.push(part)
    }
  }
  return blocks
}

const convertMessage = (message: UIMessage<AnyTools>): ReadonlyArray<Prompt.Message> => {
  switch (message.role) {
    case "system": {
      const text = message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
      return text === "" ? [] : [Prompt.makeMessage("system", { content: text })]
    }
    case "user": {
      const content: Array<Prompt.UserMessagePart> = []
      for (const part of message.parts) {
        if (part.type === "text") {
          content.push(Prompt.makePart("text", { text: part.text, ...options(part.providerMetadata) }))
        }
        if (part.type === "file") {
          content.push(filePart(part))
        }
      }
      return content.length === 0 ? [] : [Prompt.makeMessage("user", { content })]
    }
    case "assistant": {
      return steps(message.parts).flatMap(assistantStep)
    }
  }
}

/**
 * The prompt for a conversation of UI messages.
 *
 * @since 0.1.0
 */
export const convertToModelMessages = <Tools extends AnyTools>(messages: ReadonlyArray<UIMessage<Tools>>): Prompt.Prompt =>
  Prompt.fromMessages((messages as ReadonlyArray<UIMessage<AnyTools>>).flatMap(convertMessage))
