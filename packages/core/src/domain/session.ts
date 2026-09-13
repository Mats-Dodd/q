import { Schema } from "effect"

// SESSION — one conversation. Events belong to a session; a session belongs to a working directory.

export const SessionId = Schema.String.pipe(Schema.brand("SessionId"))
export type SessionId = typeof SessionId.Type

export const Session = Schema.Struct({
  id: SessionId,
  /** The directory `q` was started in. `--continue` resumes the latest session for the same directory. */
  cwd: Schema.String,
  createdAt: Schema.DateTimeUtc,
})
export type Session = typeof Session.Type
