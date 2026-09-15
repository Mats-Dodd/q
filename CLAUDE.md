# q

A terminal coding agent. Effect v4 (`4.0.0-rc.*`) on Bun. One binary (`apps/q`) runs the server, the TUI, or both.

## Commands

- `bun run verify` — the whole gate: typecheck, Effect diagnostics, lint, format check, knip, depcruise, tests. Run it before you finish.
- `bun run test` — vitest on the Bun runtime (`bun --bun vitest run`). Never `bun test` or `jest`.
- `bun run typecheck` — `tsc` (TypeScript 7, patched by `@effect/tsgo` so Effect diagnostics come out of `tsc`).
- `bun run check` — Effect diagnostics alone (`effect-tsgo diagnostics`).
- `bun run lint` / `bun run format` — oxlint / oxfmt. Config: `.oxlintrc.json`, `.oxfmtrc.json`.
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
encoded input and output. `AgentService.step(messages)` is one model call as `UIMessageChunk`s, `start-step` to
`finish-step`; it is stateless. The loop is in `core/program/update.ts`:

- `Turn`: `Idle` → `Accepting` (write-ahead `PromptAccepted`) → `Streaming {messageId, round}` → … → `Idle`.
- The `AgentTurn` subscription runs one step per `{messageId, round}`; changing the deps restarts it over the Model's messages.
- On `finish-step`, `verdict` decides: an `approval-requested` part parks the turn in `AwaitingApproval`; a step whose client
  tool calls all have results continues with `round + 1` (`StepEnded` is recorded); anything else ends the turn (`TurnEnded`).
- `RespondedToolApproval` puts the answer on the part and starts the next round. Effect's `LanguageModel` runs approved
  tools at the start of that step; their results land on the parts of the earlier step, so transcript events snapshot
  the whole assistant message, and folding takes the last snapshot. A parked turn survives a restart.
- Chunks reach the Model as they arrive; nothing waits on a clock. Deltas that arrive in one read are folded into one message (`coalesce`).
- An API response streams Models until the conversation waits on the user (`Idle` or `AwaitingApproval`).

`AgentConfig`: `Q_AGENT=echo|anthropic` (default: `anthropic` when `ANTHROPIC_API_KEY` is set, else `echo`),
`Q_ANTHROPIC_MODEL`, `Q_ECHO_DELAY`. Tool handlers are stand-ins in `core/agent/tool-handlers.ts`.

## Conventions

- Files are kebab-case. Modules are imported by path (`@q/core/session/session-service`); there are no barrel `index.ts` files.
- One service per file, as a `Context.Service` class with a static `layer`. Repositories return `PersistenceError`; services translate absence into domain errors (`SessionNotFoundError`).
- Domain errors are `Schema.TaggedError` so they cross the API. Ids are branded (`SessionId`).
- Persistence models are `Model.Class`; the API carries their JSON codec. Wire ids and counters are `Schema.Int`.
- Layers are provided once, at the entry point (`apps/q/src/cli.ts`) or at a Layer's boundary. Inside an Effect, prefer `Layer.build` in an explicit Scope over `Effect.provide`. The `strictEffectProvide` diagnostic points at the exceptions; test bodies are allowed.
- Effect diagnostics are configured in `packages/typescript-config/base.json`. Silence one line with `// @effect-diagnostics-next-line <rule>:off` and say why.
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
- `Effect.provide` memoizes by Layer reference. To rebuild a service over a substitute inside a block that already built it, use `Layer.fresh`. To share one stateful service (a scripted agent) between two runtimes, `Layer.build` it once and `Effect.provideService` it to both.
- Anything that must outlive an Effect (a server, a database) is built with `Layer.build` in the test's Scope, not with `Effect.provide`.
- Pure `update` functions are tested with the `story` DSL from `@q/kit/story`. Schemas are tested with `it.effect.prop`.
- `@q/test`: `DatabaseLayerTest` (in-memory SQLite + migrations), `makeApiClientTest(handlers)` (scripted server behind a real `ApiClient`), `assertFailsWithTag`, `awaiting`, `advancingUntil` (advance the `TestClock` step by step until a forked wait is done; one large adjust does not carry a paced stream to its end).
- `@q/factories`: `makeSession`, `makeAnsweredModel`, `makeStreamingModel`, `makeAwaitingApprovalModel`, `makeTextStep`, `textOf`, `makePromptAccepted`, `makeStepEnded`, `makeTurnEnded`; `chat-chunk` builds the chunks of one step (`makeTextChunks`, `makeWeatherCallChunks`, `makeEmailApprovalChunks`, …) for `AgentService.layerScripted`. Override only the fields the test is about.
- Assert with `assert` from `@effect/vitest`; `expect` only for snapshots.
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
