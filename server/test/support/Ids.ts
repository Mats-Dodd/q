import { Crypto, Effect } from "effect"
import { TurnId } from "../../src/domain/Turn.ts"

/** A fresh turn id, as a client would choose one. */
export const newTurnId = Effect.gen(function*() {
  const crypto = yield* Crypto.Crypto
  return TurnId.make(yield* crypto.randomUUIDv7)
}).pipe(Effect.orDie)
