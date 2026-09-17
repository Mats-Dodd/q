import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"

import { ConversationModelSchema } from "@q/domain/conversation/model"

import { OpenSessionPayload, OpenSessionResponse, SendIntentPayload } from "./schemas"

// The wire is JSON. For every value the API carries, decoding its JSON and encoding again gives the
// same JSON: nothing is lost on the wire. (Compared as JSON text: `-0` is a valid Int that JSON has no
// spelling for, so the decoded value is compared in its wire form, not by `deepStrictEqual`.)

const roundTrips = (name: string, schema: Schema.Codec<unknown>) => {
  const wire = Schema.fromJsonString(Schema.toCodecJson(schema))
  it.effect.prop(`${name} round-trips through JSON`, { value: schema }, ({ value }) =>
    Effect.gen(function* () {
      const text = yield* Schema.encodeEffect(wire)(value)
      const decoded = yield* Schema.decodeEffect(wire)(text)
      assert.strictEqual(yield* Schema.encodeEffect(wire)(decoded), text)
    }),
  )
}

describe("sessions schemas", () => {
  roundTrips("OpenSessionPayload", OpenSessionPayload)
  roundTrips("OpenSessionResponse", OpenSessionResponse)
  roundTrips("SendIntentPayload", SendIntentPayload)
  roundTrips("ConversationModel (SSE data)", ConversationModelSchema)

  it.effect("an intent with an unknown tag is rejected", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(Schema.decodeUnknownEffect(SendIntentPayload)({ _tag: "Bogus" }))
      assert.strictEqual(result._tag, "Failure")
    }),
  )
})
