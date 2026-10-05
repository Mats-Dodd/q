import { Array, Effect } from "effect"
import { Response } from "effect/ai"
import type { SessionId } from "../../src/domain/Session.ts"
import type { SessionEvent } from "../../src/domain/SessionEvent.ts"
import { MessageId, TurnId } from "../../src/domain/Turn.ts"
import { SessionEventLog } from "../../src/services/SessionEventLog.ts"

/** Events for tests that need a session to have a history, without running a model. */

export const turnId = TurnId.make("01a10400-0000-7000-8000-0000000000aa")
export const messageId = MessageId.make("01a10400-0000-7000-8000-0000000000bb")

/** The user's message `text` starting the turn. */
export const turnStarted = (text: string): SessionEvent => ({ _tag: "TurnStarted", turnId, messageId, text, model: "m" })

/** The model streaming `deltas` of text (one event, as a batch of output would be). */
export const output = (...deltas: Array.NonEmptyReadonlyArray<string>): SessionEvent => ({
  _tag: "ModelOutput",
  turnId,
  parts: Array.map(deltas, (delta) => Response.makePart("text-delta", { id: "t0", delta }))
})

/** Appends `events` at the end of the session's log. */
export const appendEvents = Effect.fnUntraced(function*(
  sessionId: SessionId,
  events: Array.NonEmptyReadonlyArray<SessionEvent>
) {
  const log = yield* SessionEventLog
  return yield* log.append(sessionId, yield* log.nextSeq(sessionId), events)
})
