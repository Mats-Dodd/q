import type * as Program from "@q/kit/program"
import { Option } from "effect"

import type { Transport } from "@q/client/transport/transport-service"
import { Send, Watch } from "./command"
import { MessageSchema } from "./message"
import type { Message } from "./message"
import type { Model } from "./model"

type Return = Program.Return<Model, Message, Transport>

/** Can this client send a prompt right now? Nothing pending here and the server idle. */
export const canSubmit = (model: Model): boolean =>
  Option.isNone(model.pending) && Option.exists(model.remote, (remote) => remote.turn._tag === "Idle")

const turnRunning = (model: Model): boolean => Option.exists(model.remote, (remote) => remote.turn._tag !== "Idle")

/** Is the server waiting on the user for a tool call? */
export const awaitingApproval = (model: Model): boolean => Option.exists(model.remote, (remote) => remote.turn._tag === "AwaitingApproval")

export const init = (): Return => ({
  model: { remote: Option.none(), pending: Option.none(), notice: Option.none() },
  commands: [Watch()],
})

/** Escape cancels the turn when one is running; otherwise it asks the server for the current Model again. */
export const update = (model: Model, message: Message): Return =>
  MessageSchema.match(message, {
    SubmittedPrompt: (intent) => {
      if (intent.text.trim() === "" || !canSubmit(model)) {
        return { model }
      }
      return {
        model: { ...model, pending: Option.some(intent.text), notice: Option.none() },
        commands: [Send({ intent })],
      }
    },
    PressedEscape: (intent) => ({
      model: { ...model, notice: Option.none() },
      commands: [turnRunning(model) ? Send({ intent }) : Watch()],
    }),
    // The server decides whether the answer fits; an answer to nothing is dropped there.
    RespondedToolApproval: (intent) => (awaitingApproval(model) ? { model, commands: [Send({ intent })] } : { model }),
    ReceivedModel: ({ model: remote }) => ({ model: { ...model, remote: Option.some(remote), pending: Option.none() } }),
    CompletedRequest: () => ({ model: { ...model, pending: Option.none() } }),
    FailedRequest: ({ error }) => ({ model: { ...model, pending: Option.none(), notice: Option.some(error) } }),
  })
