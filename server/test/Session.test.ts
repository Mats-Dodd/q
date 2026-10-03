import { it } from "@effect/vitest"
import { assertEquals } from "@effect/vitest/utils"
import { Effect, Schema } from "effect"
import { Session } from "../src/domain/Session.ts"

/** `Session.json` to and from the exact JSON text clients send and receive. */
const SessionJsonText = Schema.fromJsonString(Schema.toCodecJson(Session.json))

it.effect.prop("Session.json survives a JSON round trip", { session: Session.json }, ({ session }) =>
  Effect.gen(function*() {
    const text = yield* Schema.encodeEffect(SessionJsonText)(session)
    assertEquals(yield* Schema.decodeEffect(SessionJsonText)(text), session)
  }))
