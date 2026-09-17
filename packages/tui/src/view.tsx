import { useKeyboard } from "@opentui/solid"
import { Cause, Option } from "effect"
import type { Layer } from "effect"
import { Index, Show, createSignal } from "solid-js"
import type { Accessor } from "solid-js"

import { MessageSchema } from "@q/client/program/message"
import type { Message } from "@q/client/program/message"
import type { Model } from "@q/client/program/model"
import { program } from "@q/client/program/program"
import { awaitingApproval, canSubmit } from "@q/client/program/update"
import type { Transport } from "@q/client/transport/transport-service"
import type { AgentTools } from "@q/domain/agent/tools"
import { TurnSchema } from "@q/domain/conversation/model"
import type { ChatMessage } from "@q/domain/conversation/model"
import { createProgram } from "@q/kit/solid"
import type { SolidProgram } from "@q/kit/solid"
import { getToolName, isToolUIPart } from "effect-ai-ui/UIMessage"
import type { AnyToolUIPart, Role } from "effect-ai-ui/UIMessage"

// VIEW — a projection of the client Model, which mirrors one server session. Presentation state
// (the draft) stays in Solid.

const colors = {
  user: "#7aa2f7",
  assistant: "#9ece6a",
  system: "#565f89",
  muted: "#565f89",
  tool: "#e0af68",
  danger: "#f7768e",
} as const

const label: Record<Role, string> = { user: "you", assistant: "q", system: "system" }

/** The whole screen. The caller is the composition root and supplies the transport. A Layer that fails to build shows as a crash. */
export const App = <E,>(props: { layer: Layer.Layer<Transport, E> }) => {
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
  | { readonly _tag: "AwaitingApproval"; readonly toolName: string }
  | { readonly _tag: "Idle" }

type ToolPart = AnyToolUIPart<AgentTools>

const toolParts = (message: ChatMessage): ReadonlyArray<ToolPart> => message.parts.filter((part): part is ToolPart => isToolUIPart(part))

/** The first tool call waiting on the user, across the conversation. There is at most one message with any. */
const pendingApproval = (model: Model): Option.Option<ToolPart> =>
  Option.flatMap(model.remote, (remote) =>
    Option.fromNullishOr(remote.messages.flatMap(toolParts).find((part) => part.state === "approval-requested")),
  )

const status = (model: Model): Status => {
  if (Option.isSome(model.notice)) {
    return { _tag: "Notice", text: model.notice.value }
  }
  if (Option.isNone(model.remote)) {
    return { _tag: "Connecting" }
  }
  if (Option.isSome(model.pending)) {
    return { _tag: "Sending" }
  }
  return TurnSchema.match(model.remote.value.turn, {
    Idle: (): Status => ({ _tag: "Idle" }),
    Accepting: (): Status => ({ _tag: "Sending" }),
    Streaming: (): Status => ({ _tag: "Streaming" }),
    AwaitingApproval: (): Status => ({
      _tag: "AwaitingApproval",
      toolName: Option.match(pendingApproval(model), { onNone: () => "tool", onSome: getToolName }),
    }),
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
  const approval = select(pendingApproval)
  const awaiting = select(awaitingApproval)

  const respond = (approved: boolean) => {
    const part = Option.getOrUndefined(approval())
    if (part !== undefined) {
      dispatch(MessageSchema.cases.RespondedToolApproval.make({ toolCallId: part.toolCallId, approved }))
    }
  }

  useKeyboard((key) => {
    if (key.name === "escape") {
      dispatch(MessageSchema.cases.PressedEscape.make({}))
    }
    // While the composer is out of focus these keys reach nothing else.
    if (awaiting() && key.name === "y") {
      respond(true)
    }
    if (awaiting() && key.name === "n") {
      respond(false)
    }
  })

  return (
    <box flexDirection="column" width="100%" height="100%">
      <Chat messages={messages} pending={pending} />
      <StatusLine status={line} />
      <Composer
        canSubmit={submittable}
        focused={() => !awaiting()}
        onSubmit={(text) => dispatch(MessageSchema.cases.SubmittedPrompt.make({ text }))}
      />
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

// SEGMENTS — a message's parts as lines. Consecutive text is one line; a tool call is its own.

type Segment =
  | { readonly _tag: "Text"; readonly text: string }
  | { readonly _tag: "Reasoning"; readonly text: string }
  | { readonly _tag: "Tool"; readonly part: ToolPart }

const segments = (message: ChatMessage): ReadonlyArray<Segment> => {
  const out: Array<Segment> = []
  for (const part of message.parts) {
    const last = out.at(-1)
    if (part.type === "text" || part.type === "reasoning") {
      const tag = part.type === "text" ? "Text" : "Reasoning"
      if (last?._tag === tag) {
        out[out.length - 1] = { _tag: tag, text: last.text + part.text }
      } else {
        out.push({ _tag: tag, text: part.text })
      }
    } else if (isToolUIPart(part)) {
      out.push({ _tag: "Tool", part })
    }
  }
  return out.length === 0 ? [{ _tag: "Text", text: "" }] : out
}

/** The call as the model made it: the tool and the argument that identifies the call, not every argument. */
const describeCall = (part: ToolPart): string => {
  const name = getToolName(part)
  if (part.state === "input-streaming") {
    return `${name}(…)`
  }
  if (part.state === "output-error") {
    return `${name}(${JSON.stringify(part.input)})`
  }
  switch (part.type) {
    case "tool-read": {
      const { path, offset, limit } = part.input
      const window = offset === undefined && limit === undefined ? "" : `:${offset ?? 1}${limit === undefined ? "" : `+${limit}`}`
      return `read(${path}${window})`
    }
    case "tool-write": {
      return `write(${part.input.path})`
    }
    case "tool-edit": {
      return `edit(${part.input.path})`
    }
    case "tool-bash": {
      return `bash(${part.input.command})`
    }
    case "dynamic-tool": {
      return `${name}(${JSON.stringify(part.input)})`
    }
  }
}

/** What a finished call produced, in a few words. The content itself is for the model, not the screen. */
const describeOutput = (part: Extract<ToolPart, { readonly state: "output-available" }>): string => {
  switch (part.type) {
    case "tool-read": {
      return `${part.output.totalLines} lines${part.output.truncated ? ", truncated" : ""}`
    }
    case "tool-write": {
      return `${part.output.bytes} bytes${part.output.created ? ", created" : ""}`
    }
    case "tool-edit": {
      return `${part.output.replacements} ${part.output.replacements === 1 ? "replacement" : "replacements"}`
    }
    case "tool-bash": {
      return `exit ${part.output.exitCode}${part.output.timedOut ? ", timed out" : ""}${part.output.truncated ? ", output truncated" : ""}`
    }
    case "dynamic-tool": {
      return JSON.stringify(part.output)
    }
  }
}

/** One line for a tool call: the call, then what became of it. */
const describeTool = (part: ToolPart): string => {
  const call = describeCall(part)
  switch (part.state) {
    case "input-streaming": {
      return call
    }
    case "input-available": {
      return `${call} running…`
    }
    case "approval-requested": {
      return `${call} → approve? y / n`
    }
    case "approval-responded": {
      return `${call} → ${part.approval.approved ? "approved" : "denied"}`
    }
    case "output-available": {
      return `${call} → ${describeOutput(part)}`
    }
    case "output-error": {
      return `${call} → error: ${part.errorText}`
    }
    case "output-denied": {
      return `${call} → denied`
    }
  }
}

const Row = (props: { message: Accessor<ChatMessage> }) => (
  <box flexDirection="column">
    <Index each={segments(props.message())}>
      {(segment, index) => (
        <text selectable={false} wrapMode="word">
          <Show when={index === 0} fallback={<span>{" ".repeat(label[props.message().role].length + 3)}</span>}>
            <span style={{ fg: colors[props.message().role] }}>{label[props.message().role]}</span>
            {" › "}
          </Show>
          <SegmentText segment={segment} />
        </text>
      )}
    </Index>
  </box>
)

/** Reactive: a segment changes in place as a tool call moves through its states. */
const SegmentText = (props: { segment: Accessor<Segment> }) => {
  const text = () => {
    const s = props.segment()
    return s._tag === "Tool" ? `⚙ ${describeTool(s.part)}` : s.text
  }
  const style = () => {
    const s = props.segment()
    switch (s._tag) {
      case "Text": {
        return {}
      }
      case "Reasoning": {
        return { fg: colors.muted }
      }
      case "Tool": {
        return { fg: s.part.state === "approval-requested" ? colors.danger : colors.tool }
      }
    }
  }
  return <span style={style()}>{text()}</span>
}

const StatusLine = (props: { status: Accessor<Status> }) => {
  const text = () => {
    const s = props.status()
    switch (s._tag) {
      case "Notice": {
        return s.text
      }
      case "Connecting": {
        return "connecting…"
      }
      case "Sending": {
        return "sending…"
      }
      case "Streaming": {
        return "streaming… Esc to cancel"
      }
      case "AwaitingApproval": {
        return `approve ${s.toolName}? y / n · Esc cancels`
      }
      case "Idle": {
        return "Enter sends · Esc cancels · Ctrl+C quits"
      }
    }
  }
  const color = () => (props.status()._tag === "Notice" ? colors.danger : colors.muted)
  return (
    <box height={1} paddingLeft={1}>
      <text fg={color()}>{text()}</text>
    </box>
  )
}

const Composer = (props: { canSubmit: Accessor<boolean>; focused: Accessor<boolean>; onSubmit: (text: string) => void }) => {
  const [draft, setDraft] = createSignal("")
  return (
    <box border borderStyle="rounded" borderColor={colors.muted} height={3} paddingLeft={1} paddingRight={1}>
      <input
        focused={props.focused()}
        width="100%"
        placeholder="Type a message…"
        value={draft()}
        onInput={setDraft}
        onSubmit={() => {
          // Refused submits keep the draft: a presentation decision made from a Model selector.
          if (!props.canSubmit()) {
            return
          }
          const text = draft()
          setDraft("")
          props.onSubmit(text)
        }}
      />
    </box>
  )
}
