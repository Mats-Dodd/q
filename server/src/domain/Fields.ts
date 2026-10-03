import { Schema } from "effect"
import { Model } from "effect/schema"

/**
 * A UTC instant on the wire as an RFC 3339 string. The `date-time` format makes
 * it a real timestamp type for generated clients (e.g. `chrono::DateTime<Utc>`
 * in Rust) instead of a bare string. Use this for every wire timestamp.
 */
export const IsoDateTime = Schema.DateTimeUtcFromString.pipe(Schema.annotateEncoded({ format: "date-time" }))

/** Set from `Clock` on insert; never updated. */
export const CreatedAt = Model.fieldEvolve(Model.DateTimeInsert, { json: () => IsoDateTime })

/** Set from `Clock` on insert and on every update. */
export const UpdatedAt = Model.fieldEvolve(Model.DateTimeUpdate, { json: () => IsoDateTime })
