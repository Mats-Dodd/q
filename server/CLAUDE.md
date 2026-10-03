# server

The q agent server: Effect v4 on Bun. Runs bundled next to the TUI (sidecar) or,
later, on Cloudflare (Worker + Durable Objects via alchemy).

## Commands

```sh
bun run dev        # watch mode, DevTools on (Effect VS Code extension)
bun run start      # q-server serve  (--port/Q_PORT 7777, --host/Q_HOST 127.0.0.1)
bun run check      # typecheck + lint + test — run before calling anything done
bun run codegen    # regenerate generated/*.json after changing the API or wire types
bun run client     # exercise a running server via the typed client (Q_SERVER_URL)
```

Docs at `/docs` (Scalar), spec at `/openapi.json`.
Config keys are all defined in `src/ServerConfig.ts`: `Q_DB_PATH` (default
`.data/q.db`, `:memory:` for throwaway), `Q_LOG_FILE` (JSON logs to file instead of
console), `Q_DEVTOOLS`, `Q_PORT`, `Q_HOST`. The client reads `Q_SERVER_URL`.

## Layout (dependencies point down only)

```
src/domain/      Model.Class schemas, branded ids, domain errors — depends on nothing
src/api/         HttpApi contract (also the source of all generated schemas) — domain only
src/services/    repos + domain services
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
  `bun build --compile` and Worker bundling). Never edit a shipped migration; add one.
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

## Wire types (anything a non-TypeScript client sees)

- The `Api` is the only registry: `generated/wire.schema.json` is derived from the
  OpenAPI components, so every schema with an `identifier` that the API uses becomes a
  named type. Run `bun run codegen`; `test/Codegen.test.ts` fails if `generated/` is
  stale. Rust types: `cargo typify generated/wire.schema.json`.
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
  `#[serde(tag = "_tag")]` in Rust.
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
