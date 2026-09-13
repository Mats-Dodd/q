import { Array, Cause, Context, Data, DateTime, Effect, Layer, Schema } from "effect"
import { Migrator, SqlClient, SqlSchema } from "effect/unstable/sql"

import { ConversationEvent } from "../domain/event"
import { type Session, SessionId } from "../domain/session"

// TRANSCRIPT REPOSITORY — sessions and their events, in storage. The SQL lives here and nowhere else.
// Parse, do not validate: rows become domain values at this boundary or they are a `TranscriptError`.

/** Storage refused, or returned something that is not a transcript. `message` is for the notice line. */
export class TranscriptError extends Data.TaggedError("TranscriptError")<{ readonly cause: unknown }> {
  override get message(): string {
    const cause = this.cause
    return cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)
  }
}

export class TranscriptRepository extends Context.Service<
  TranscriptRepository,
  {
    readonly createSession: (cwd: string) => Effect.Effect<Session, TranscriptError>
    /** Sessions started in `cwd`, newest first. */
    readonly sessions: (cwd: string) => Effect.Effect<ReadonlyArray<Session>, TranscriptError>
    /** Fails with `NoSuchElementError` when there is no such session. */
    readonly findSession: (id: SessionId) => Effect.Effect<Session, TranscriptError | Cause.NoSuchElementError>
    readonly append: (id: SessionId, event: ConversationEvent) => Effect.Effect<void, TranscriptError>
    /** The events of one session in append order. */
    readonly events: (id: SessionId) => Effect.Effect<ReadonlyArray<ConversationEvent>, TranscriptError>
  }
>()("TranscriptRepository") {}

// ROWS

const EventJson = Schema.fromJsonString(ConversationEvent)
const EventRow = Schema.Struct({ body: EventJson })

const SessionRow = Schema.Struct({ id: SessionId, cwd: Schema.String, created_at: Schema.DateTimeUtcFromMillis })
const toSession = (row: typeof SessionRow.Type): Session => ({ id: row.id, cwd: row.cwd, createdAt: row.created_at })

const migrations = Migrator.fromRecord({
  "0001_init": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      cwd TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`
    yield* sql`CREATE INDEX sessions_cwd ON sessions (cwd, created_at)`
    yield* sql`CREATE TABLE events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions (id),
      kind TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`
    yield* sql`CREATE INDEX events_session ON events (session_id, seq)`
  }),
})

/** Everything that is not "no such row" is a `TranscriptError`. */
const orTranscriptError = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.catchIf(
    self,
    (error): error is Exclude<E, Cause.NoSuchElementError> => !Cause.isNoSuchElementError(error),
    (cause) => Effect.fail(new TranscriptError({ cause })),
  )

/**
 * The repository over any `SqlClient`. Runs its migrations when the Layer is built. The SQL is
 * SQLite's dialect; the composition root binds the client.
 */
export const SqlTranscriptRepository: Layer.Layer<TranscriptRepository, TranscriptError, SqlClient.SqlClient> =
  Layer.effect(
    TranscriptRepository,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* Migrator.make({})({ loader: migrations, table: "q_migrations" })

      const selectSessions = SqlSchema.findAll({
        Request: Schema.Struct({ cwd: Schema.String }),
        Result: SessionRow,
        execute: ({ cwd }) => sql`SELECT id, cwd, created_at FROM sessions WHERE cwd = ${cwd} ORDER BY created_at DESC, rowid DESC`,
      })
      const selectSession = SqlSchema.findAll({
        Request: Schema.Struct({ id: SessionId }),
        Result: SessionRow,
        execute: ({ id }) => sql`SELECT id, cwd, created_at FROM sessions WHERE id = ${id}`,
      })
      const selectEvents = SqlSchema.findAll({
        Request: Schema.Struct({ id: SessionId }),
        Result: EventRow,
        execute: ({ id }) => sql`SELECT body FROM events WHERE session_id = ${id} ORDER BY seq`,
      })
      const encodeEvent = Schema.encodeEffect(EventJson)

      const createSession = Effect.fn("TranscriptRepository.createSession")(function* (cwd: string) {
        const session: Session = { id: SessionId.make(crypto.randomUUID()), cwd, createdAt: yield* DateTime.now }
        yield* sql`INSERT INTO sessions (id, cwd, created_at) VALUES (${session.id}, ${cwd}, ${DateTime.toEpochMillis(session.createdAt)})`
        return session
      }, orTranscriptError)

      const sessions = Effect.fn("TranscriptRepository.sessions")(function* (cwd: string) {
        return Array.map(yield* selectSessions({ cwd }), toSession)
      }, orTranscriptError)

      const findSession = Effect.fn("TranscriptRepository.findSession")(
        (id: SessionId) => selectSession({ id }).pipe(Effect.head, Effect.map(toSession)),
        orTranscriptError,
      )

      const append = Effect.fn("TranscriptRepository.append")(function* (id: SessionId, event: ConversationEvent) {
        const body = yield* encodeEvent(event)
        const now = DateTime.toEpochMillis(yield* DateTime.now)
        yield* sql`INSERT INTO events (session_id, kind, body, created_at) VALUES (${id}, ${event._tag}, ${body}, ${now})`
      }, orTranscriptError)

      const events = Effect.fn("TranscriptRepository.events")(function* (id: SessionId) {
        return Array.map(yield* selectEvents({ id }), (row) => row.body)
      }, orTranscriptError)

      return { createSession, sessions, findSession, append, events }
    }).pipe(orTranscriptError),
  )
