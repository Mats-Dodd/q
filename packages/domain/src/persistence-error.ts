import { Schema } from "effect"

/** Storage refused. Infrastructure failures cross the service boundary as this, and only this. */
export class PersistenceError extends Schema.TaggedError<PersistenceError>()(
  "PersistenceError",
  {
    cause: Schema.optional(Schema.Defect()),
    message: Schema.String,
  },
  { httpApiStatus: 500 },
) {}
