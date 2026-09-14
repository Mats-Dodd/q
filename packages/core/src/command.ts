import { Effect } from "effect"

import { Command } from "@q/kit"
import { ConversationEvent, type Outcome } from "./domain/event"
import { Message } from "./message"
import { Transcript } from "./services/transcript"

// COMMAND — one-shot effects, described in `update`, run by the runtime. Failures become Messages.

export const AcceptPrompt = Command.define("AcceptPrompt", ({ prompt }: { readonly prompt: string }) =>
  Effect.flatMap(Transcript, (transcript) => transcript.append(ConversationEvent.cases.PromptAccepted.make({ prompt }))).pipe(
    Effect.as(Message.cases.SucceededAcceptPrompt.make({})),
    Effect.catch((error) => Effect.succeed(Message.cases.FailedAcceptPrompt.make({ error: error.message }))),
  ),
)

export const CommitTurn = Command.define(
  "CommitTurn",
  ({ messageId, text, outcome }: { readonly messageId: number; readonly text: string; readonly outcome: Outcome }) =>
    Effect.flatMap(Transcript, (transcript) => transcript.append(ConversationEvent.cases.TurnEnded.make({ text, outcome }))).pipe(
      Effect.as(Message.cases.SucceededCommitTurn.make({ messageId })),
      Effect.catch((error) => Effect.succeed(Message.cases.FailedCommitTurn.make({ messageId, error: error.message }))),
    ),
)
