import type { ChatChunk } from "@q/domain/conversation/model"

// The chunks one agent step is made of, for scripted agents. `start-step`/`finish-step` are added by the agent.

/** One text part, start to end. */
export const makeTextChunks = (text: string, id = "text-0"): ReadonlyArray<ChatChunk> => [
  { type: "text-start", id },
  { type: "text-delta", id, delta: text },
  { type: "text-end", id },
]

/** A `read` call the agent ran: input, then output. */
export const makeReadCallChunks = (toolCallId: string, path: string, content = "hello\n"): ReadonlyArray<ChatChunk> => [
  { type: "tool-input-start", toolCallId, toolName: "read" },
  { type: "tool-input-available", toolCallId, toolName: "read", input: { path } },
  { type: "tool-output-available", toolCallId, output: { path, content, totalLines: content.split("\n").length - 1, truncated: false } },
]

/** A `bash` call the agent parked for the user's approval. No tool asks for approval by itself; a provider or a test may. */
export const makeBashApprovalChunks = (toolCallId: string, approvalId: string, command = "make"): ReadonlyArray<ChatChunk> => [
  { type: "tool-input-start", toolCallId, toolName: "bash" },
  { type: "tool-input-available", toolCallId, toolName: "bash", input: { command } },
  { type: "tool-approval-request", toolCallId, approvalId },
]

/** The result of an approved `bash`, as the step after the approval emits it. */
export const makeBashOutputChunk = (toolCallId: string, output = "", exitCode = 0): ChatChunk => ({
  type: "tool-output-available",
  toolCallId,
  output: { exitCode, output, truncated: false, timedOut: false },
})

/** The result of a denied call, as the step after the denial emits it. */
export const makeDeniedChunk = (toolCallId: string): ChatChunk => ({ type: "tool-output-denied", toolCallId })
