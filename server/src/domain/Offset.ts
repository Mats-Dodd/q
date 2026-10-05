import { Schema, SchemaTransformation } from "effect"

const width = 16

/**
 * A position in a session stream: the `seq` of the next chunk to read, so
 * reading from an offset returns every chunk with `seq >= offset`.
 *
 * Durable Streams offsets are opaque, lexicographically sortable strings. On
 * the wire this is the seq zero-padded to 16 digits (sorting as text sorts as
 * numbers); the protocol's `-1` sentinel ("from the beginning") decodes to 0.
 */
export const Offset = Schema.String.check(Schema.isPattern(new RegExp(`^(-1|\\d{${width}})$`))).pipe(
  Schema.decodeTo(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(Schema.brand("Offset")),
    SchemaTransformation.transform({
      decode: (text) => text === "-1" ? 0 : Number(text),
      encode: (seq) => String(seq).padStart(width, "0")
    })
  )
).annotate({ identifier: "Offset" })
export type Offset = typeof Offset.Type

/** The beginning of every stream (the protocol's `-1`). */
export const beginning = Offset.make(0)

/** The offset just past the chunk at `seq`. */
export const after = (seq: number): Offset => Offset.make(seq + 1)

/** Where to start reading: an `Offset`, or `now` for only what is appended from here on. */
export const ReadFrom = Schema.Union([Schema.Literal("now"), Offset]).annotate({ identifier: "ReadFrom" })
export type ReadFrom = typeof ReadFrom.Type
