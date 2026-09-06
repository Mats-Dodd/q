# q — architecture

A terminal coding agent. Elm architecture on Effect, with OpenTUI + Solid as a pure view layer.

Each tool does what it is good at. Elm decides state transitions. Effect owns services, async work,
streams, cancellation and cleanup. Solid owns fine-grained projections and ephemeral UI state.
OpenTUI owns terminal layout, input and demand-driven rendering.

## Tenets

1. **The Model is the in-memory truth.** `update` is the only thing that changes it, and it is pure:
   no time, randomness, IO or mutation. Anything impure is requested as a typed effect and comes
   back as a Message.
2. **Messages are inputs, not records.** Keypresses, text chunks, command results. They are batched
   at the source, folded once, and never persisted. Named as past-tense facts.
3. **The transcript is the durable truth.** Domain events at turn granularity, appended by Commands
   and folded back into a Model by `init`. Schemas validate at that boundary, not on every dispatch.
4. **Write-ahead to start a turn, write-behind to end it.** A prompt enters `messages` only after
   the transcript has accepted it: that round trip is the request itself, and the wait is an
   explicit `Accepting` state the view shows as a pending row. Ending a turn is a record, so the
   turn goes `Idle` at once and the outcome is appended behind it; a failure is a notice. Appends
   land in issue order, which is the transcript Layer's contract, not something the user waits on.
   Streaming text is display state until the turn ends and is committed as one event.
5. **Effect owns lifetimes.** Commands and Subscriptions run in the runtime Scope. Cancellation is
   cooperative: Effect interrupts obsolete work, `update` guards against stragglers by state and id.
6. **Solid owns presentation.** Selectors over the Model for what the user sees; local signals and
   resources for anything that would not matter after a restart. The test: if the process restarted,
   would reproducing this state matter? If not, it is Solid state.

## Packages

Bun workspaces. Each package's `exports` points at TypeScript source, so there is no build step and
one root `tsc --noEmit` checks everything. The boundaries are the seams:

```
packages/kit    @q/kit          the runtime; knows no domain. `@q/kit/solid` is the Solid bridge,
                                `@q/kit/testing` the story DSL and scheduler helpers.
packages/core   @q/core         the agent program, headless: model, messages, transcript events,
                                service tags with in-memory Layers, update, subscriptions.
packages/tui    @q/tui          the OpenTUI + Solid view over a core program.
apps/q          q               the binary. Composition root: picks the Layers, renders, compiles.
```

| Package        | May import                                   | Never imports              |
| -------------- | -------------------------------------------- | -------------------------- |
| `@q/kit`       | effect                                       | anything under `@q/`       |
| `@q/kit/solid` | effect, solid-js                             | @opentui                   |
| `@q/core`      | effect, `@q/kit`                             | solid-js, @opentui, tui    |
| `@q/tui`       | @opentui, solid-js, `@q/kit/solid`, `@q/core` | concrete production Layers |
| `q`            | everything                                   |                            |

Real services (a model provider, a file or remote transcript) arrive as new packages that depend on
`@q/core` for the tags and are wired only in `apps/q`. The echo agent and the in-memory transcript
stay in core: an ephemeral session is a real mode, not a test double.

## Runtime (`@q/kit`, generic)

Borrowed from Foldkit's runtime, minus the DOM.

```
dispatch(msg):
  pending.push(msg); if not draining: drain()

drain():                                  // synchronous, FIFO, on the caller's stack
  batch(() =>                             // Solid batch: N messages -> one reactive flush
    while pending:
      msg  = pending.shift()
      next = update(model, msg)           // pure; a throw crashes the runtime
      log.publish(msg)                    // committed log: only applied messages are published
      if next.model !== model:            // reference equality only
        model = next.model
        models.publish(model)             // feeds subscriptions
        onModel(model)                    // the Solid bridge sets the Model signal
      for cmd in next.commands:
        queueMicrotask(() => forkIn(scope)(cmd.effect |> flatMap(dispatch)))
  )
```

- **Flags** run once at boot inside the runtime, before `init`. Loading the transcript lives here.
- **Commands** are `{ name, args, effect }` data. Constructing one in `update` runs nothing. They fork
  into the runtime Scope one microtask later. Failures must become `Failed*` Messages inside the
  command; anything escaping is a defect that crashes the program.
- **Subscriptions** are `{ deps, modelToDeps, depsToStream }`. The runtime subscribes to model
  changes synchronously at boot, maps each Model to its deps, filters by Schema equivalence, and
  `switchMap`s into `depsToStream`. A Model change interrupts the old stream and starts the new one.
- **Crash** is idempotent, reports once, and closes the runtime Scope so nothing keeps running under
  a dead UI. The Solid bridge shows the cause; OpenTUI's console overlay captures it too.
- **Streams out**: `messages` (committed log) and `models`. Consumers own retention. The runtime keeps
  no history. `replay(update, initial, messages)` is the purity check used by tests.

**Solid bridge** (`@q/kit/solid`): `createProgram(program, layer)` boots through `createResource`,
because flags may load from somewhere slow or remote. It returns `{ app, crash }`; `app()` yields
`{ model, select, dispatch }` once up. `select` wraps `createMemo`, so a slice only notifies when it
changes by reference. The Model is one signal, not a store: Solid's `reconcile` mutates the previous
object graph in place, which would corrupt an immutable Model and anything holding an older one.
With reference-preserving updates, `select` and `<Index>` give the same one-leaf updates.

## Application (`@q/core`)

```ts
// MODEL
ChatMessage = { id, role, text }
Turn        = Idle
            | Accepting  { prompt }              PromptAccepted being appended; shown as a pending row
            | Streaming  { messageId, prompt }   agent subscription live
Model       = { messages, turn, nextId, notice: Option<string> }

// TRANSCRIPT EVENTS (durable)
PromptAccepted { prompt }
TurnEnded      { text, outcome: Completed | Cancelled | Failed { error } }

// MESSAGES (inputs)
SubmittedPrompt          SucceededAcceptPrompt   FailedAcceptPrompt
ReceivedText             CompletedTurn           FailedTurn
PressedEscape            SucceededCommitTurn     FailedCommitTurn

// COMMANDS                                  // SERVICES
AcceptPrompt { prompt }   -> Transcript       Agent      { stream(prompt): Stream<string> }
CommitTurn   { id, text, outcome }            Transcript { append(event), load }
```

**Transitions.** Every branch checks the turn state and id. A message that does not fit leaves the
Model untouched, by reference.

- Idle + SubmittedPrompt (non-blank) → Accepting, clear notice, command `AcceptPrompt`.
- Accepting + SucceededAcceptPrompt → append user row and empty assistant row → Streaming.
- Accepting + FailedAcceptPrompt → Idle with notice. No row was ever shown.
- Streaming + ReceivedText (same id) → append text.
- Streaming + CompletedTurn / FailedTurn (same id) → Idle, command `CommitTurn`.
- Streaming + PressedEscape → Idle, `CommitTurn` with the partial text and a cancelled outcome.
- SucceededCommitTurn is ignored. FailedCommitTurn sets the notice in any state; the row stays.
- Everything else is ignored, including Escape while Accepting.

**Subscription.** `AgentTurn` is gated on `Streaming`. Leaving that state changes the deps and the
runtime interrupts the stream. Chunks are mapped to `ReceivedText`, followed by `CompletedTurn`, with
failures caught into `FailedTurn`, then `groupedWithin(64, "33 millis")` and coalesced so each batch
is one text message plus any terminal message, in order. 33ms is one frame at OpenTUI's default
30fps; delivering faster is coalesced by the renderer anyway.

**Resume.** `init(flags)` folds transcript events into rows. A resumed Model equals the live one for
the same events (tested). A transcript that ends on `PromptAccepted` was interrupted mid-turn; the
fold marks the row `[interrupted]` in the Model only. Repairing the transcript on resume is a
follow-up.

**Layers.** `apps/q/layer.ts` composes the echo agent plus an in-memory transcript. Tests substitute instant,
failing, read-only or gated Layers. No file-backed Layer yet. When one lands it must serialise
`append` (a semaphore of one permit or a queue): a turn's `TurnEnded` and the next turn's
`PromptAccepted` can be in flight together, and the fold in `init` relies on their order.

## View (`@q/tui`)

- Alternate screen, demand-driven renderer. Never `start()`.
- `App` takes the Layers from its caller, shows `loading…` until boot, a crash box if the runtime
  dies, else `Session`.
- `Session` holds one `useKeyboard` (Escape) and four selectors: messages, turn, notice, canSubmit.
- `Chat`: `<scrollbox stickyScroll stickyStart="bottom" focusable={false}>` over `<Index>`. Rows are
  `<text selectable={false} wrapMode="word">` with the role span and the text leaf; the `Index`
  item accessor means a batch replaces one text node. While `Accepting`, a dimmed pending row shows
  the prompt straight from the turn state. It is presentation only and never enters `messages`.
- `StatusLine`: sending, streaming, or the notice.
- `Composer`: local `draft` signal, controlled `<input focused>`. A refused submit (turn not Idle)
  keeps the draft. It never sees Messages or `dispatch`.

Later, not now: `<markdown streaming>` for assistant rows; split-footer with scrollback commits for
finished turns; `@opentui/keymap` when bindings need to be user-configurable; a small state-machine
table for `Turn` once tools and approvals make the transition list long.

## Testing

1. **Story tests** (`@q/kit/testing`, most tests). Drive `update` with Messages, inspect Commands as
   data by name, resolve them by feeding the result Message back. Pure, no Effect runs. They test
   decisions, not interleavings.
2. **Runtime tests.** `Runtime.make` under Effect's `TestClock` with substitute Layers. Cover
   batching, cancellation, write-ahead, a gated Layer with two appends in flight, failure Layers,
   resume, crash, and the purity check
   (`replay` over the collected `messages` stream). `settle` and `tick` from `@q/kit/testing` yield
   to the event loop because fibers woken by a synchronous `dispatch` only run when it turns.
3. **View tests** (few). `testRender` with `kittyKeyboard: true`, mock keys, `waitForFrame`, and a
   trimmed `captureCharFrame` snapshot. Needs `[test] preload` in `bunfig.toml`; the top-level
   preload is ignored by `bun test`.

## Where this is heading

The agent loop is a state machine in the Model. `Turn` grows variants such as `AwaitingApproval` and
`RunningTool`, each stage a Subscription gated on its variant, approvals as Messages that move the
machine forward. Tool calls are Commands. Transcript events grow to cover tool requests, approvals
and results. Nothing in the kit changes.

## Setup

- `effect@4.0.0-rc.112`, `@opentui/core@0.5.10`, `@opentui/solid@0.5.10`, `solid-js@1.9.12`, exact.
- `tsconfig.json`: `"jsx": "preserve"`, `"jsxImportSource": "@opentui/solid"`, one file at the root.
- `bunfig.toml`: hoisted linker (Bun 1.4 defaults to isolated, which breaks the single root
  node_modules the tsconfig and test preload rely on); `apps/q` has its own preload for `bun start`.
- `bun start`, `bun test`, `bun run typecheck`, `bun run build` (compiles `apps/q/dist/q`).
