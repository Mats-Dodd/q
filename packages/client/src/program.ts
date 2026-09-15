import { Effect, Option, Schema, Stream } from "effect"

import { Command, type Program } from "@q/kit"
import { Intent, Model as Remote } from "@q/core"
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

// What comes back from a request. Local to the client; the server never sees these.
const ReceivedModel = Schema.TaggedStruct("ReceivedModel", { model: Remote })
const CompletedRequest = Schema.TaggedStruct("CompletedRequest", {})
const FailedRequest = Schema.TaggedStruct("FailedRequest", { error: Schema.String })

/**
 * The user's intents are core's own schemas, not copies: `Message.cases.SubmittedPrompt` is the same
 * object as `core.Message.cases.SubmittedPrompt`, so an intent is sent as it is. Escape cancels the
 * turn when one is running; otherwise it asks the server for the current Model again.
 */
export const Message = Schema.Union([...Intent.members, ReceivedModel, CompletedRequest, FailedRequest]).pipe(
  Schema.toTaggedUnion("_tag"),
)
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
    SubmittedPrompt: (intent) => {
      if (intent.text.trim() === "" || !canSubmit(model)) return { model }
      return {
        model: { ...model, pending: Option.some(intent.text), notice: Option.none() },
        commands: [Send({ intent })],
      }
    },
    PressedEscape: (intent) => ({
      model: { ...model, notice: Option.none() },
      commands: [turnRunning(model) ? Send({ intent }) : Watch()],
    }),
    ReceivedModel: ({ model: remote }) => ({ model: { ...model, remote: Option.some(remote), pending: Option.none() } }),
    CompletedRequest: () => ({ model: { ...model, pending: Option.none() } }),
    FailedRequest: ({ error }) => ({ model: { ...model, pending: Option.none(), notice: Option.some(error) } }),
  })

export const program: Program.Program<Model, Message, Transport> = { flags: Effect.void, init, update }
