import type { ChatChunk } from "@q/domain/conversation/model"

// The chunks one agent step is made of, for scripted agents. `start-step`/`finish-step` are added by the agent.

/** One text part, start to end. */
export const makeTextChunks = (text: string, id = "text-0"): ReadonlyArray<ChatChunk> => [
  { type: "text-start", id },
  { type: "text-delta", id, delta: text },
  { type: "text-end", id },
]

/** A `get_weather` call the agent ran: input, then output. */
export const makeWeatherCallChunks = (
  toolCallId: string,
  city: string,
  output: { readonly temperatureC: number; readonly sky: string } = { temperatureC: 6, sky: "clear" },
): ReadonlyArray<ChatChunk> => [
  { type: "tool-input-start", toolCallId, toolName: "get_weather" },
  { type: "tool-input-available", toolCallId, toolName: "get_weather", input: { city } },
  { type: "tool-output-available", toolCallId, output: { city, ...output } },
]

/** A `send_email` call the agent parked for the user's approval. */
export const makeEmailApprovalChunks = (
  toolCallId: string,
  approvalId: string,
  input: { readonly to: string; readonly subject: string; readonly body: string } = { to: "a@b.c", subject: "hi", body: "hello" },
): ReadonlyArray<ChatChunk> => [
  { type: "tool-input-start", toolCallId, toolName: "send_email" },
  { type: "tool-input-available", toolCallId, toolName: "send_email", input },
  { type: "tool-approval-request", toolCallId, approvalId },
]

/** The result of an approved `send_email`, as the step after the approval emits it. */
export const makeEmailSentChunk = (toolCallId: string, to = "a@b.c"): ChatChunk => ({
  type: "tool-output-available",
  toolCallId,
  output: { sent: true, to },
})

/** The result of a denied call, as the step after the denial emits it. */
export const makeDeniedChunk = (toolCallId: string): ChatChunk => ({ type: "tool-output-denied", toolCallId })
