import { Effect, Option, Schema, Stream } from "effect"

import { Command, type Program } from "@q/kit"
import { type Intent, Message as RemoteMessage, Model as Remote } from "@q/core"
import { Transport } from "./transport"

// CLIENT PROGRAM — a thin mirror of the server. The Model is the server's Model as last seen plus
// what only this client knows: a prompt it has sent but not seen accepted, and a transport notice.
// Every request streams whole Models back; each one replaces the mirror.

export const Model = Schema.Struct({
  /** The server's Model as last seen. `None` until the first `watch` answers. */
  remote: Schema.Option(Remote),
  /** A prompt sent and not yet reflected by the server. Shown as pending; blocks a second prompt. */
  pending: Schema.Option(Schema.String),
  /** A one-line transport problem, cleared on the next request. */
  notice: Schema.Option(Schema.String),
})
export type Model = typeof Model.Type

export const Message = Schema.TaggedUnion({
  SubmittedPrompt: { text: Schema.String },
  /** Cancel the turn when one is running; otherwise ask the server for the current Model again. */
  PressedEscape: {},
  ReceivedModel: { model: Remote },
  CompletedRequest: {},
  FailedRequest: { error: Schema.String },
})
export type Message = typeof Message.Type

// COMMANDS

const asMessages = (models: Stream.Stream<Remote, { readonly message: string }>): Stream.Stream<Message> =>
  models.pipe(
    Stream.map((model) => Message.cases.ReceivedModel.make({ model })),
    Stream.concat(Stream.make(Message.cases.CompletedRequest.make({}))),
    Stream.catch((error) => Stream.make(Message.cases.FailedRequest.make({ error: error.message }))),
  )

/** Dispatch one intent on the server and mirror the Models it streams back. */
export const Send = Command.defineStream("Send", ({ intent }: { intent: Intent }) =>
  Stream.unwrap(Effect.map(Transport, (transport) => asMessages(transport.send(intent)))),
)

/** Mirror the server's current Model and follow the running turn, if any. */
export const Watch = Command.defineStream("Watch", (_: {}) => Stream.unwrap(Effect.map(Transport, (transport) => asMessages(transport.watch))))

// UPDATE

/** Can this client send a prompt right now? Nothing pending here and the server idle. */
export const canSubmit = (model: Model): boolean =>
  Option.isNone(model.pending) && Option.exists(model.remote, (remote) => remote.turn._tag === "Idle")

const turnRunning = (model: Model): boolean => Option.exists(model.remote, (remote) => remote.turn._tag !== "Idle")

export const init = (): Program.Return<Model, Message, Transport> => ({
  model: { remote: Option.none(), pending: Option.none(), notice: Option.none() },
  commands: [Watch()],
})

export const update = (model: Model, message: Message): Program.Return<Model, Message, Transport> =>
  Message.match(message, {
    SubmittedPrompt: ({ text }) => {
      if (text.trim() === "" || !canSubmit(model)) return { model }
      return {
        model: { ...model, pending: Option.some(text), notice: Option.none() },
        commands: [Send({ intent: RemoteMessage.cases.SubmittedPrompt.make({ text }) })],
      }
    },
    PressedEscape: () => ({
      model: { ...model, notice: Option.none() },
      commands: [turnRunning(model) ? Send({ intent: RemoteMessage.cases.PressedEscape.make({}) }) : Watch()],
    }),
    ReceivedModel: ({ model: remote }) => ({ model: { ...model, remote: Option.some(remote), pending: Option.none() } }),
    CompletedRequest: () => ({ model: { ...model, pending: Option.none() } }),
    FailedRequest: ({ error }) => ({ model: { ...model, pending: Option.none(), notice: Option.some(error) } }),
  })

export const program: Program.Program<Model, Message, Transport> = { flags: Effect.void, init, update }
