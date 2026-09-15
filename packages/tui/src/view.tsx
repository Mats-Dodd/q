import { useKeyboard } from "@opentui/solid"
import { Cause, type Layer, Option } from "effect"
import { type Accessor, Index, Show, createSignal } from "solid-js"

import { type Message, MessageSchema } from "@q/client/program/message"
import type { Model } from "@q/client/program/model"
import { program } from "@q/client/program/program"
import { canSubmit } from "@q/client/program/update"
import type { Transport } from "@q/client/transport/transport-service"
import { type ChatMessage, type Role, TurnSchema } from "@q/domain/conversation/model"
import { type SolidProgram, createProgram } from "@q/kit/solid"

// VIEW — a projection of the client Model, which mirrors one server session. Presentation state
// (the draft) stays in Solid.

const colors = {
  user: "#7aa2f7",
  assistant: "#9ece6a",
  muted: "#565f89",
  danger: "#f7768e",
} as const

const label: Record<Role, string> = { user: "you", assistant: "q" }

/** The whole screen. The caller is the composition root and supplies the transport. A Layer that fails to build shows as a crash. */
export const App = (props: { layer: Layer.Layer<Transport, unknown> }) => {
  const { app, crash } = createProgram(program, props.layer)
  return (
    <Show
      when={crash()}
      keyed
      fallback={
        <Show when={app()} keyed fallback={<Loading />}>
          {(app: SolidProgram<Model, Message>) => <Session app={app} />}
        </Show>
      }
    >
      {(cause: Cause.Cause<unknown>) => <Crashed cause={cause} />}
    </Show>
  )
}

const Loading = () => (
  <box padding={1}>
    <text fg={colors.muted}>loading…</text>
  </box>
)

const Crashed = (props: { cause: Cause.Cause<unknown> }) => (
  <box flexDirection="column" padding={1} border borderStyle="rounded" borderColor={colors.danger}>
    <text fg={colors.danger}>q crashed. Ctrl+C to quit.</text>
    <text fg={colors.muted}>{Cause.pretty(props.cause)}</text>
  </box>
)

/** What the status line says. One of these, in this order of importance. */
type Status =
  | { readonly _tag: "Notice"; readonly text: string }
  | { readonly _tag: "Connecting" }
  | { readonly _tag: "Sending" }
  | { readonly _tag: "Streaming" }
  | { readonly _tag: "Idle" }

const status = (model: Model): Status => {
  if (Option.isSome(model.notice)) return { _tag: "Notice", text: model.notice.value }
  if (Option.isNone(model.remote)) return { _tag: "Connecting" }
  if (Option.isSome(model.pending)) return { _tag: "Sending" }
  return TurnSchema.match(model.remote.value.turn, {
    Idle: (): Status => ({ _tag: "Idle" }),
    Accepting: (): Status => ({ _tag: "Sending" }),
    Streaming: (): Status => ({ _tag: "Streaming" }),
  })
}

/** The prompt on its way to the conversation: sent by this client, or being accepted by the server. */
const pendingPrompt = (model: Model): Option.Option<string> =>
  Option.orElse(model.pending, () =>
    Option.flatMap(model.remote, (remote) => (remote.turn._tag === "Accepting" ? Option.some(remote.turn.prompt) : Option.none())),
  )

const Session = (props: { app: SolidProgram<Model, Message> }) => {
  const { select, dispatch } = props.app
  const messages = select((model) => Option.match(model.remote, { onNone: () => [], onSome: (remote) => remote.messages }))
  const line = select(status)
  const submittable = select(canSubmit)
  const pending = select(pendingPrompt)

  useKeyboard((key) => {
    if (key.name === "escape") dispatch(MessageSchema.cases.PressedEscape.make({}))
  })

  return (
    <box flexDirection="column" width="100%" height="100%">
      <Chat messages={messages} pending={pending} />
      <StatusLine status={line} />
      <Composer canSubmit={submittable} onSubmit={(text) => dispatch(MessageSchema.cases.SubmittedPrompt.make({ text }))} />
    </box>
  )
}

const Chat = (props: { messages: Accessor<ReadonlyArray<ChatMessage>>; pending: Accessor<Option.Option<string>> }) => (
  <scrollbox flexGrow={1} stickyScroll stickyStart="bottom" focusable={false} paddingLeft={1} paddingRight={1}>
    <Show when={props.messages().length === 0 && Option.isNone(props.pending())}>
      <text fg={colors.muted}>Type a message and press Enter.</text>
    </Show>
    <Index each={props.messages()}>{(message) => <Row message={message} />}</Index>
    <Show when={Option.getOrUndefined(props.pending())} keyed>
      {(prompt: string) => <PendingRow prompt={prompt} />}
    </Show>
  </scrollbox>
)

/** A prompt the conversation has not accepted yet. Presentation only: it is not in `messages`. */
const PendingRow = (props: { prompt: string }) => (
  <text selectable={false} wrapMode="word" fg={colors.muted}>
    <span style={{ fg: colors.muted }}>{label.user}</span>
    {" › "}
    {props.prompt}
  </text>
)

const Row = (props: { message: Accessor<ChatMessage> }) => (
  <text selectable={false} wrapMode="word">
    <span style={{ fg: colors[props.message().role] }}>{label[props.message().role]}</span>
    {" › "}
    {props.message().text}
  </text>
)

const StatusLine = (props: { status: Accessor<Status> }) => {
  const text = () => {
    const s = props.status()
    switch (s._tag) {
      case "Notice":
        return s.text
      case "Connecting":
        return "connecting…"
      case "Sending":
        return "sending…"
      case "Streaming":
        return "streaming… Esc to cancel"
      case "Idle":
        return "Enter sends · Esc cancels · Ctrl+C quits"
    }
  }
  const color = () => (props.status()._tag === "Notice" ? colors.danger : colors.muted)
  return (
    <box height={1} paddingLeft={1}>
      <text fg={color()}>{text()}</text>
    </box>
  )
}

const Composer = (props: { canSubmit: Accessor<boolean>; onSubmit: (text: string) => void }) => {
  const [draft, setDraft] = createSignal("")
  return (
    <box border borderStyle="rounded" borderColor={colors.muted} height={3} paddingLeft={1} paddingRight={1}>
      <input
        focused
        width="100%"
        placeholder="Type a message…"
        value={draft()}
        onInput={setDraft}
        onSubmit={() => {
          // Refused submits keep the draft: a presentation decision made from a Model selector.
          if (!props.canSubmit()) return
          const text = draft()
          setDraft("")
          props.onSubmit(text)
        }}
      />
    </box>
  )
}
