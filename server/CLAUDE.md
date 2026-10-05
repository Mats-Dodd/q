# server

The q agent server: Effect v4 on Bun. Runs bundled next to the TUI (sidecar) or,
later, on Cloudflare (Worker + Durable Objects via alchemy).

## Commands

```sh
bun run dev        # watch mode, DevTools on (Effect VS Code extension)
bun run start      # q-server serve  (--port/Q_PORT 7777, --host/Q_HOST 127.0.0.1)
bun run check      # typecheck + lint + test — run before calling anything done
bun run codegen    # regenerate generated/*.json after changing the API or wire types
bun run fixtures   # regenerate golden session transcripts (test/fixtures/sessions)
bun run client     # exercise a running server via the typed client (Q_SERVER_URL)
bun run fake-anthropic  # the tests' fake model on :7778, for working without a key
```

Docs at `/docs` (Scalar), spec at `/openapi.json`.
Config keys are all defined in `src/ServerConfig.ts`: `Q_DB_PATH` (default
`.data/q.db`, `:memory:` for throwaway), `Q_LOG_FILE` (JSON logs to file instead of
console), `Q_DEVTOOLS`, `Q_PORT`, `Q_HOST`, `ANTHROPIC_API_KEY` (required; Bun loads
it from `server/.env`, which is git-ignored), `Q_MODEL` (default `claude-haiku-4-5`),
`Q_ANTHROPIC_URL` (a proxy, or `http://127.0.0.1:7778` with `bun run fake-anthropic`).
The client reads `Q_SERVER_URL`.

## Layout (dependencies point down only)

```
src/domain/      Model.Class schemas, branded ids, domain errors — depends on nothing
src/api/         HttpApi contract (also the source of all generated schemas) — domain only
src/services/    repos + domain services (SessionRuntimes, AgentLoop, SessionEventLog, SessionStreams)
src/ai/          the LanguageModel layer: which provider turns run on
src/http/        HttpApiBuilder handlers (thin) + ApiLive
src/db/          SqlClient layer, migrations, Database (migrated SqlClient)
src/client/      typed ApiClient service
src/codegen/     JSON Schema (for Rust) + OpenAPI generation
src/ServerConfig.ts  every config key the server reads
src/AppLive.ts   composition root for app services (no transport)
src/main.ts      Bun entry (effect/cli), the only place platform layers are chosen
```

## Conventions

- **Domain first.** Entities are `Model.Class`; API endpoints use its variants
  (`Session.json`, `.jsonCreate`, `.jsonUpdate`), repos use `SqlModel.makeRepository`.
- **Build Model values with `makeEffect`, never `make`.** `make` evaluates effectful
  defaults (ids, `DateTimeInsert`/`Update`) on the real clock; `makeEffect` runs them in
  the current fiber so `Clock`/`TestClock` apply.
- **Services:** `interface XShape` first, then
  `class X extends Context.Service<X, XShape>()("@q/server/<path>", { make: Effect.gen(...) })
  { static readonly layer = Layer.effect(X, X.make) }`. Keys are the deterministic
  file-path key (lint-enforced). Methods are `Effect.fn("X.method")(...)` so every call
  is a span; tag it with `Effect.annotateCurrentSpan` (e.g. `sessionId`).
  Layers leave dependencies open; they are closed only in `AppLive.ts` / `main.ts`.
- **Construct schema classes with `X.make({...})`, never `new X(...)`** (lint-enforced).
- **Errors:** domain errors are `Schema.TaggedError` with `httpApiStatus`. Database
  failures stay the driver's typed `SqlError` all the way through services (it carries a
  classified `reason` and `isRetryable`; use `Effect.catchReason` / `Effect.retry`
  rather than wrapping it). Row decode failures (`SchemaError` from SQL) and invariant
  violations (our own `makeEffect` failing) are defects.
- **Handlers are thin:** call a service, `Effect.catchTag("SqlError", Effect.die)`,
  return. HttpApi renders the defect as an empty 500, `HttpMiddleware.logger` logs the
  cause, and `withErrorReporting` forwards it to any `ErrorReporter`. Don't hand-roll this.
- **Writes are single statements.** No read-then-write: `UPDATE`/`DELETE ... RETURNING`
  via `SqlSchema.findOneOption`, and report "missing" through the result (`Option`,
  `boolean`). Use `sql.withTransaction` when one operation needs several statements.
- **Branch on unions with `Match` + `Match.exhaustive`**, so new cases are compile errors.
- **Migrations** are TypeScript, statically imported via `Migrator.fromRecord` (survives
  `bun build --compile` and Worker bundling). Never edit a migration that may have run
  anywhere (committed or not: it has likely run on a dev database); add one.
- **SQL portability:** repos only touch `SqlClient`/`SqlSchema`/`SqlModel`. Only
  `db/Sql.ts` knows the driver. Avoid `.stream` queries (unsupported on bun sqlite).
- **Config** only through `ServerConfig` (never `process.env`, lint-enforced); add new
  keys there. `Config.Redacted` for secrets.
- **Lint is maximal:** oxlint `strict` + `effect-native` + `style` presets, correctness/
  suspicious/perf as errors, `--deny-warnings`; Effect suggestions fail `tsc`. Entry
  points (`main.ts`, `scripts/`) may `Effect.provide` a layer with a
  `// oxlint-disable-next-line effecttsgo/strict-effect-provide -- entry point` comment;
  nowhere else.
- **Unstable APIs** are opted into explicitly in `tsconfig.json`
  (`allowedUnstableApis`). Adding a new unstable module there is a deliberate decision.
  Versions of `effect` / `@effect/*` are pinned exactly.

## Sessions, events and projections

Vocabulary (keep names to it): a **session** is a conversation, a sequence of
**turns**; a turn is one activation of the agent, from the user's message through
its reasoning, tool calls and output to the reply, made of **steps** (model calls).
A session's **events** are the single record of what happened; everything else is a
**projection** of them. Clients send **messages** (with their own `MessageId`, so
retries are safe); the server decides what a message does (today: start a turn).

- **One store.** `session_events` (via `SessionEventLog`) holds every session's
  events (`domain/SessionEvent.ts`): `TurnStarted`, `StepStarted`, `ModelOutput` (the
  model's raw `effect/ai` parts, batched: every delta, signatures, ids), `TurnEnded`
  (`Completed | Cancelled | Failed`). Events are never changed; evolve them by adding
  event types or optional fields. Appends are checked against the writer's version
  (`VersionConflict`), mark the session used, and are published only once committed.
- **Projections.** The **session stream** clients read is `streamChunksOf` applied to
  every event (`domain/StreamProjection.ts`): offsets are event seqs, reads end on
  event boundaries, and projecting must be deterministic. The **model's history** and
  turn state are `SessionState`, the events folded (`evolve`).
- **Decider.** `domain/SessionState.ts` is pure: `evolve(state, event)` and
  `decide…(state, command)`. Test session rules there, without a server.
- **`SessionRuntimes`**: an actor per session (`RcMap`, idle eviction; a running turn
  holds it open) holding its folded state. Every change goes through `transact`:
  decide from the state, append, fold in, as one uninterruptible step. Commands run
  one at a time; the turn is a child fiber (cancel = interrupt). On open, a turn left
  running by a crash is ended as failed; startup opens such sessions.
- **`AgentLoop`** is the agent and only the agent: history in, a stream of
  `AgentOutput` (steps, raw parts) out. No storage, no sessions; the runtime records
  what it produces (batched into `ModelOutput`s; failures travel through the batching
  as values so what was produced is kept).

## Wire types (anything a non-TypeScript client sees)

- The `Api` is the only registry: `generated/wire.schema.json` is derived from the
  OpenAPI components, so every schema with an `identifier` that the API uses becomes a
  named type. Run `bun run codegen`; `test/Codegen.test.ts` fails if `generated/` is
  stale.
- Give every wire type an `identifier` (Model variants too: annotate them where the
  API uses them, e.g. `Session.jsonCreate.annotate({ identifier: "SessionCreate" })`). Use `Finite`/`Int` (never `Number`),
  `optionalKey`/`NullOr` (never `Option`), `Literals` for enums.
- Timestamps: `IsoDateTime` from `domain/Fields.ts` (or `CreatedAt`/`UpdatedAt` on
  models), never a bare `DateTimeUtcFromString` — the `date-time` format is what turns
  them into `chrono::DateTime<Utc>` in Rust.
- Every endpoint also declares the API-wide errors from `api/ApiErrors.ts`:
  `RequestInvalid` (400, per-field `issues`; HttpApi's default is an empty 400 body)
  and `InternalServerErrorNoContent` (empty 500, decoded as `InternalServerError`).
- Tagged unions: `TaggedClass` variants + `Schema.toTaggedUnion("_tag")` →
  `#[serde(tag = "_tag")]` in Rust. **Exception:** protocol-owned types keep the
  protocol's names. `domain/UiChunk.ts` is a port of the AI SDK's chunk schema (pinned to
  `ai@7.0.127`; `test/StreamChunk.test.ts` checks every chunk against the AI SDK's own
  schema), discriminated on `type`; the Durable Streams headers/control fields follow
  that spec.
- Types the API only carries as JSON text (SSE event data) are invisible to OpenAPI:
  list them in `embedded` in `codegen/Codegen.ts`.
- No empty structs on the wire: `Schema.Struct({})` becomes "any non-null value",
  which the Rust generator cannot express.
- Rust types are generated by the client's `build.rs` from `generated/wire.schema.json`.
- Secrets: `Schema.Redacted(S, { disallowJsonEncode: true })`.

## Testing — no mocks

- Tests run the **production layers**; only config changes (`test/support/TestConfig.ts`,
  e.g. `Q_DB_PATH=:memory:`). No `vi.mock`, no stub layers, no `Layer.mock`.
  If something seems to need a mock, add a config seam or use a real lightweight backend.
- `test/support/AppTest.ts` — app services on a fresh in-memory DB (also exposes its
  `SqlClient`). `test/support/ServerTest.ts` — the real HTTP app on a random port + the
  typed client over real HTTP, plus a raw `HttpClient` and the server's `SqlClient`.
- Test failure paths for real: break the actual database (rename/drop a table through
  `SqlClient`) in its own `layer(...)` block, never by stubbing.
- Decode raw HTTP responses with `HttpClientResponse.schemaJson(...)`, not casts.
- Use `layer(X)("suite", (it) => ...)` + `it.effect`. `it.effect` runs on `TestClock`
  (`TestClock.adjust` / `setTime` from `effect/testing`); `it.live` for real time.
- One DB per suite: tests create their own data and never assert global counts.
- `it.effect.prop` round-trip tests for wire schemas (through `Schema.fromJsonString`).
- Assertions come from `@effect/vitest/utils` (not `expect`, not chai `assert`):
  `assertEquals` (Effect `Equal`) for domain values, `assertSome`/`assertNone` for
  `Option`, and `assertFailure(yield* Effect.result(eff), SomeError.make({...}))` for
  expected failures — compare the whole error, not just `_tag`. `strictEqual` /
  `deepStrictEqual` / `assertTrue` for plain values.
- Runner is `bun --bun vitest` (needed for `bun:sqlite` and `BunHttpServer.layerTest`).
- The model is `test/support/FakeAnthropic.ts`: a real local Anthropic Messages API
  (streaming) that `TestConfig` points `Q_ANTHROPIC_URL` at, scripted by the user's
  message (`slow …`, `fail …`, `overloaded …`, else it echoes) and recording prompts.
  Suites that stream from it run on real time: `layer(X, { excludeTestServices: true })`.
- **Golden transcripts** (`test/fixtures/sessions`): each `<name>.jsonl` stream and
  the `<name>.turns.json` the AI SDK's own `readUIMessageStream` makes of it.
  The Rust client's fold is tested against the same files. Add a fixture when a new
  kind of chunk is emitted, then `bun run fixtures`.
