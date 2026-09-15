import { Schema } from "effect"
import { Model } from "effect/unstable/schema"

// SESSION — one conversation. Events belong to a session; a session belongs to a working directory.

export const SessionId = Schema.String.pipe(Schema.brand("SessionId"))
export type SessionId = typeof SessionId.Type

export class Session extends Model.Class<Session>("Session")({
  id: Model.GeneratedByApp(SessionId),
  /** The directory `q` was started in. `--continue` resumes the latest session for the same directory. */
  cwd: Schema.String,
  createdAt: Model.DateTimeInsertFromNumber,
}) {}

/** Which session a launch of `q` continues. Decided at the composition root, from the command line. */
export const ResumeSchema = Schema.TaggedUnion({
  /** Start a new session. */
  New: {},
  /** The latest session for the working directory, or a new one if there is none. */
  Latest: {},
  /** A specific session. Unknown ids fail. */
  Session: { id: SessionId },
})
export type Resume = typeof ResumeSchema.Type
