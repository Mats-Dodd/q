import { type ConversationEvent, ConversationEventSchema, type Outcome, OutcomeSchema } from "@q/domain/transcript/model"

export const makePromptAccepted = (prompt = "hi"): ConversationEvent => ConversationEventSchema.cases.PromptAccepted.make({ prompt })

export const makeTurnEnded = (text = "hi", outcome: Outcome = OutcomeSchema.cases.Completed.make({})): ConversationEvent =>
  ConversationEventSchema.cases.TurnEnded.make({ text, outcome })
