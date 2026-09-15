import type { ChatMessagePart } from "@q/domain/conversation/model"
import { type ConversationEvent, ConversationEventSchema, type Outcome } from "@q/domain/transcript/model"
import * as Command from "@q/kit/command"
import { Effect } from "effect"

import { CurrentSession } from "../session/current-session"
import { TranscriptService } from "../transcript/transcript-service"
import { MessageSchema } from "./message"

// COMMAND — one-shot effects, described in `update`, run by the runtime. Failures become Messages.

const append = Effect.fn("Command.append")(function* append(event: ConversationEvent) {
  const { id } = yield* CurrentSession
  const transcript = yield* TranscriptService
  yield* transcript.append(id, event)
})

export const AcceptPrompt = Command.define("AcceptPrompt", ({ prompt }: { readonly prompt: string }) =>
  append(ConversationEventSchema.cases.PromptAccepted.make({ prompt })).pipe(
    Effect.as(MessageSchema.cases.SucceededAcceptPrompt.make({})),
    Effect.catch((error) => Effect.succeed(MessageSchema.cases.FailedAcceptPrompt.make({ error: error.message }))),
  ),
)

export const CommitStep = Command.define(
  "CommitStep",
  ({ messageId, round, parts }: { readonly messageId: string; readonly round: number; readonly parts: ReadonlyArray<ChatMessagePart> }) =>
    append(ConversationEventSchema.cases.StepEnded.make({ parts })).pipe(
      Effect.as(MessageSchema.cases.SucceededCommitStep.make({ messageId, round })),
      Effect.catch((error) => Effect.succeed(MessageSchema.cases.FailedCommitStep.make({ messageId, round, error: error.message }))),
    ),
)

export const CommitTurn = Command.define(
  "CommitTurn",
  ({
    messageId,
    parts,
    outcome,
  }: {
    readonly messageId: string
    readonly parts: ReadonlyArray<ChatMessagePart>
    readonly outcome: Outcome
  }) =>
    append(ConversationEventSchema.cases.TurnEnded.make({ parts, outcome })).pipe(
      Effect.as(MessageSchema.cases.SucceededCommitTurn.make({ messageId })),
      Effect.catch((error) => Effect.succeed(MessageSchema.cases.FailedCommitTurn.make({ messageId, error: error.message }))),
    ),
)
