import { Effect } from "effect"

import { Command } from "@q/kit"
import { Message } from "./message"
import { ConversationEvent, type Outcome, Transcript } from "./transcript"

// COMMAND — one-shot effects, described in `update`, run by the runtime. Failures become Messages.

export const AcceptPrompt = Command.define("AcceptPrompt", ({ prompt }: { readonly prompt: string }) =>
  Effect.flatMap(Transcript, (transcript) => transcript.append(ConversationEvent.PromptAccepted({ prompt }))).pipe(
    Effect.as(Message.SucceededAcceptPrompt()),
    Effect.catch((error) => Effect.succeed(Message.FailedAcceptPrompt({ error: error.message }))),
  ),
)

export const CommitTurn = Command.define(
  "CommitTurn",
  ({ messageId, text, outcome }: { readonly messageId: number; readonly text: string; readonly outcome: Outcome }) =>
    Effect.flatMap(Transcript, (transcript) => transcript.append(ConversationEvent.TurnEnded({ text, outcome }))).pipe(
      Effect.as(Message.SucceededCommitTurn({ messageId })),
      Effect.catch((error) => Effect.succeed(Message.FailedCommitTurn({ messageId, error: error.message }))),
    ),
)
