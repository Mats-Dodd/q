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

export const CommitTurn = Command.define(
  "CommitTurn",
  ({ messageId, text, outcome }: { readonly messageId: number; readonly text: string; readonly outcome: Outcome }) =>
    append(ConversationEventSchema.cases.TurnEnded.make({ text, outcome })).pipe(
      Effect.as(MessageSchema.cases.SucceededCommitTurn.make({ messageId })),
      Effect.catch((error) => Effect.succeed(MessageSchema.cases.FailedCommitTurn.make({ messageId, error: error.message }))),
    ),
)
