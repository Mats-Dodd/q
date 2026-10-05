import { Crypto, Effect } from "effect"
import { MessageId } from "../../src/domain/Turn.ts"

/** A fresh message id, as a client would choose one. */
export const newMessageId = Effect.gen(function*() {
  const crypto = yield* Crypto.Crypto
  return MessageId.make(yield* crypto.randomUUIDv7)
}).pipe(Effect.orDie)
