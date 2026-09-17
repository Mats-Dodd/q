# q

A terminal coding agent. Effect v4 (`4.0.0-rc.*`) on Bun. One binary (`apps/q`) runs the server, the TUI, or both.

## Commands

- `bun run verify` — the whole gate: typecheck, lint, format check, knip, depcruise, tests. Run it before you finish. `git push` runs it too.
- `bun run test` — vitest on the Bun runtime (`bun --bun vitest run`). Never `bun test` or `jest`.
- `bun run typecheck` — `tsc` (TypeScript 7, patched by `@effect/tsgo`; its Effect diagnostics are off, oxlint reports them).
- `bun run lint` — oxlint, type-aware, patched by `@effect/tsgo`: every Effect diagnostic (`effecttsgo/*`), the type-aware
  `typescript/*` rules, `import`, `unicorn`, `promise`, `vitest`. Everything is an error; there are no warnings. Config: `.oxlintrc.json`.
- `bun run format` — oxfmt. Config: `.oxfmtrc.json`.
- `bun run knip` — unused files, exports and dependencies. Config: `knip.json`.
- `bun run depcruise` — the dependency rules below, enforced. Config: `.dependency-cruiser.cjs`.
- `bun run start -- <flags>` — run the CLI from source. `bun run build` — a single binary at `apps/q/dist/q`.
- `bun install` also installs the git hooks (`lefthook.yml`) and patches `tsc`.

## Layout

```
packages/ai-ui           effect-ai-ui, a publishable library: the AI SDK UI message protocol for effect/unstable/ai.
                         UIMessage/UIMessageChunk schemas typed from a Toolkit, LanguageModel parts -> chunks, a pure
                         reducer, UIMessage -> Prompt, SSE. Imports effect only; never @q/*. Exports are Effect-style
                         (`effect-ai-ui/UIMessage`), files are kebab-case.
packages/domain          shared kernel: schemas, branded ids, models, errors. effect and effect-ai-ui only.
                         agent/tools.ts holds the tool definitions (Tool.make), not their handlers.
packages/config          typed config services read from the environment. effect only.
packages/api-definition  the HTTP contract (effect/unstable/httpapi). Depends on domain only.
packages/db              SQLite client + migrations. Owns no table; core modules do.
packages/core            business logic, one folder per module:
  session/               session-service, session-repository, current-session
  transcript/            transcript-service, transcript-repository
  agent/                 agent-service (one LanguageModel step as UIMessageChunks), tool-handlers
  program/               the Elm program: message, command, update, subscription, program. `update` runs the agent loop.
  session-runtime/       live program runtimes per session
packages/kit             Elm architecture on Effect: Runtime, Command, story DSL, Solid bridge.
packages/client          the client program that mirrors one server session over HTTP + SSE.
packages/tui             the OpenTUI/Solid view over @q/client.
packages/factories       builders for domain values in tests.
packages/test            test infrastructure: in-memory db, scripted API server, runtime helpers, exit assertions.
apps/q                   composition root: api handlers (src/api), layers (src/layers), commands (src/commands), cli.ts.
                         Integration tests in apps/q/test/integration.
```

Dependency direction (enforced by depcruise): `ai-ui` ← `domain`, `config` ← `api-definition`, `db` ← `core` ← `apps/q`.
`ai-ui` imports nothing from the workspace. `core/agent` is the only place that imports `effect/unstable/ai` for a provider.
`client` and `tui` reach the server only through `api-definition`. `test` and `factories` are never imported by runtime code.
A `*-repository.ts` is private to its module; other modules go through the module's service. API handlers speak to services only.

## The agent loop

Messages are AI SDK `UIMessage`s typed by `AgentToolkit` (`@q/domain/agent/tools`); a tool part carries that tool's
encoded input and output. `AgentService.step(messages, { cwd })` is one model call as `UIMessageChunk`s, `start-step` to
`finish-step`; it is stateless. The loop is in `core/program/update.ts`:

- `Turn`: `Idle` → `Accepting` (write-ahead `PromptAccepted`) → `Streaming {messageId, round}` → … → `Idle`.
- The `AgentTurn` subscription runs one step per `{messageId, round}`; changing the deps restarts it over the Model's messages.
- On `finish-step`, `verdict` decides: an `approval-requested` part parks the turn in `AwaitingApproval`; a step whose client
  tool calls all have results continues with `round + 1` (`StepEnded` is recorded); anything else ends the turn (`TurnEnded`).
- `RespondedToolApproval` puts the answer on the part and starts the next round. Effect's `LanguageModel` runs approved
  tools at the start of that step; their results land on the parts of the earlier step, so transcript events snapshot
  the whole assistant message, and folding takes the last snapshot. A parked turn survives a restart.
- A step that fails or dies is a `FailedStep`: the turn ends `Failed` with a notice. A defect never crashes the runtime, which
  would leave the session `Streaming` with nothing on the screen.
- Chunks reach the Model as they arrive; nothing waits on a clock. Deltas that arrive in one read are folded into one message (`coalesce`).
- An API response streams Models until the conversation waits on the user (`Idle` or `AwaitingApproval`).

`AgentConfig`: `Q_AGENT=echo|anthropic` (default: `anthropic` when `ANTHROPIC_API_KEY` is set, else `echo`),
`Q_ANTHROPIC_MODEL`, `Q_ECHO_DELAY`.

## Tools

`read`, `write`, `edit`, `bash`, as pi ships them. Contracts in `domain/agent/tools.ts`; handlers in `core/agent/tool-handlers.ts`
over `FileSystem`, `Path`, `ChildProcessSpawner` (Bun's, from `BunServices.layer` at the composition root).

- Every tool is `failureMode: "return"`: a missing file or an ambiguous `edit` is `{ reason, message }` for the model, not a
  failed turn. A non-zero exit code is a `bash` success value. No tool asks for approval on its own.
- Paths resolve against the session's `cwd` (`CurrentSession`), which `AgentTurn` passes to `step`; the handlers are bound to
  it per step (no I/O). Paths are not sandboxed. The system prompt names the directory.
- Limits are constants in `tool-handlers.ts`: `read` caps at 2000 lines / 64 KiB and says `truncated`; `bash` gets 2 minutes
  (or `timeoutMs`), keeps 1 MiB of interleaved output, reads the rest so the child never blocks, and reports `timedOut` with
  exit code `-1` and what was printed. `edit` replaces text literally (`$` is not special).
- The TUI shows a call as `tool(argument) → summary` (`bash(make) → exit 0`, `read(a.ts) → 12 lines`), never the content.

## Conventions

- Files are kebab-case. Modules are imported by path (`@q/core/session/session-service`), also inside their own package (the package
  self-references through its `exports` map; `apps/q` is `q/layers/app`). Never `../`. There are no barrel `index.ts` files.
- `import type { X }` on its own line, never `import { type X }`. `ReadonlyArray<T>`, not `readonly T[]`. `interface`, not `type`, for object shapes.
- Braces on every `if` and `case`. No nested ternaries, no negated conditions with an `else`, no `!` non-null assertions (narrow, or `assert.fail`).
- A Schema class is built with `Foo.make({...})`, not `new Foo({...})`. `Schema.is(Foo)`, not `instanceof`.
- One service per file, as a `Context.Service` class with a static `layer`. Repositories return `PersistenceError`; services translate absence into domain errors (`SessionNotFoundError`).
- Domain errors are `Schema.TaggedError` so they cross the API. Ids are branded (`SessionId`).
- Persistence models are `Model.Class`; the API carries their JSON codec. Wire ids and counters are `Schema.Int`.
- Layers are provided once, at the entry point (`apps/q/src/cli.ts`) or at a Layer's boundary. Inside an Effect, `Layer.build` in an explicit Scope, never `Effect.provide` (`effecttsgo/strict-effect-provide`); in a test body, `providing` from `@q/test/runtime`.
- A rule is silenced on one line with `// oxlint-disable-next-line <rule> -- <why>`. The reason is not optional. A rule that is off for the whole repo has its reason in `.oxlintrc.json`.
- A cast that narrows (`as X`) is `typescript/no-unsafe-type-assertion`: prove it with a type guard or a decode, or disable the line and say what makes it safe.
- Backward compat is never a consideration.

## Bun

- `bun <file>` not `node`; `bun install`; `bunx <pkg>` not `npx`. Bun loads `.env` itself.
- `bun:sqlite` for SQLite. `Bun.serve()` for HTTP. `Bun.file` over `node:fs`. Bun.$`ls` over execa.
- Docs: `node_modules/bun-types/docs/**.mdx`.

## Testing

Tests are colocated: `foo.test.ts` beside `foo.ts`. Fixtures are `*.fixture.ts`. Integration tests live in `apps/q/test/integration`.
OpenTUI's FFI and `bun:sqlite` need Bun; Node's vitest cannot host them. Config: `vitest.config.ts`.

- `it.effect` runs on a `TestClock` (and `TestConsole`) in its own Scope. `it.live` uses the real clock.
- `layer(L)("name", (it) => ...)` builds `L` once for the block. `excludeTestServices: true` where the real clock matters (SQLite `created_at`, OpenTUI frames).
- Never `Effect.provide` in a test body: it closes the Layer's scope when the body returns, before a runtime made inside has finished with it. `providing(layer)` from `@q/test/runtime` builds the Layer in the test's Scope and gives its context to the body. Layers memoize by reference: to rebuild a service over a substitute inside a block that already built it, use `Layer.fresh`. To share one stateful service (a scripted agent) between two runtimes, `Layer.build` it once and `Effect.provideService` it to both.
- Pure `update` functions are tested with the `story` DSL from `@q/kit/story`. Schemas are tested with `it.effect.prop`.
- `@q/test`: `DatabaseLayerTest` (in-memory SQLite + migrations), `makeApiClientTest(handlers)` (scripted server behind a real `ApiClient`), `assertFailsWithTag`, `providing`, `awaiting`, `advancingUntil` (advance the `TestClock` step by step until a forked wait is done; one large adjust does not carry a paced stream to its end).
- `@q/factories`: `makeSession`, `makeAnsweredModel`, `makeStreamingModel`, `makeAwaitingApprovalModel`, `makeTextStep`, `textOf`, `makePromptAccepted`, `makeStepEnded`, `makeTurnEnded`; `chat-chunk` builds the chunks of one step (`makeTextChunks`, `makeReadCallChunks`, `makeBashApprovalChunks`, …) for `AgentService.layerScripted`. Override only the fields the test is about.
- Assert with `assert` from `@effect/vitest`; `expect` only for snapshots, and every snapshot has a hint (`toMatchSnapshot("asked")`). A helper that asserts is named `assert…` (`assertUnchanged`, `assertNone`); `vitest/expect-expect` counts those.
- Tests follow the same rules as source. A wire fixture that needs `null` disables `unicorn/no-null` around itself and says why.
- Time is `TestClock.adjust`. Completion is a message on `Runtime.messages`: fork the wait before the dispatch, join after. Never sleep or count yields.

```ts
import { assert, it, layer } from "@effect/vitest"
import { Effect } from "effect"

layer(Foo.layer)("Foo", (it) => {
  it.effect("adds context", () =>
    Effect.gen(function* () {
      const foo = yield* Foo
      assert.strictEqual(foo, "foo")
    }),
  )
})
```
