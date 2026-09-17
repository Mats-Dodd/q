import type { ChatMessagePart } from "@q/domain/conversation/model"
import { ConversationEventSchema, OutcomeSchema } from "@q/domain/transcript/model"
import type { ConversationEvent, Outcome } from "@q/domain/transcript/model"

import { makeTextStep } from "./conversation-model"

export const makePromptAccepted = (prompt = "hi"): ConversationEvent => ConversationEventSchema.cases.PromptAccepted.make({ prompt })

export const makeStepEnded = (parts: ReadonlyArray<ChatMessagePart>): ConversationEvent =>
  ConversationEventSchema.cases.StepEnded.make({ parts })

/** A turn that ended with the assistant message `parts`. A string is one step of text. */
export const makeTurnEnded = (
  parts: ReadonlyArray<ChatMessagePart> | string = "hi",
  outcome: Outcome = OutcomeSchema.cases.Completed.make({}),
): ConversationEvent =>
  ConversationEventSchema.cases.TurnEnded.make({ parts: typeof parts === "string" ? makeTextStep(parts) : parts, outcome })
