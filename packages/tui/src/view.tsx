import { useKeyboard } from "@opentui/solid"
import { Cause, type Layer, Option } from "effect"
import { type Accessor, Index, Show, createSignal } from "solid-js"

import { type Agent, type ChatMessage, Message, type Model, type Role, type Transcript, Turn, program } from "@q/core"
import { type SolidProgram, createProgram } from "@q/kit/solid"

// VIEW — a projection of the Model. Presentation state (the draft) stays in Solid.

const colors = {
  user: "#7aa2f7",
  assistant: "#9ece6a",
  muted: "#565f89",
  danger: "#f7768e",
} as const

const label: Record<Role, string> = { user: "you", assistant: "q" }

/** The whole screen. The caller is the composition root and supplies the Layers. A Layer that fails to build shows as a crash. */
export const App = (props: { layer: Layer.Layer<Agent | Transcript, unknown> }) => {
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

const Session = (props: { app: SolidProgram<Model, Message> }) => {
  const { select, dispatch } = props.app
  const messages = select((model) => model.messages)
  const turn = select((model) => model.turn)
  const notice = select((model) => model.notice)
  const canSubmit = select((model) => model.turn._tag === "Idle")
  // The prompt being accepted, so the user sees their words before the transcript answers.
  const pending = select((model) => (model.turn._tag === "Accepting" ? Option.some(model.turn.prompt) : Option.none()))

  useKeyboard((key) => {
    if (key.name === "escape") dispatch(Message.cases.PressedEscape.make({}))
  })

  return (
    <box flexDirection="column" width="100%" height="100%">
      <Chat messages={messages} pending={pending} />
      <StatusLine turn={turn} notice={notice} />
      <Composer canSubmit={canSubmit} onSubmit={(text) => dispatch(Message.cases.SubmittedPrompt.make({ text }))} />
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

/** A prompt the transcript has not accepted yet. Presentation only: it is not in `messages`. */
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

const StatusLine = (props: { turn: Accessor<Turn>; notice: Accessor<Option.Option<string>> }) => {
  const text = () =>
    Turn.match(props.turn(), {
      Idle: () => Option.getOrElse(props.notice(), () => "Enter sends · Esc cancels · Ctrl+C quits"),
      Accepting: () => "sending…",
      Streaming: () => "streaming… Esc to cancel",
    })
  const color = () => (props.turn()._tag === "Idle" && Option.isSome(props.notice()) ? colors.danger : colors.muted)
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
