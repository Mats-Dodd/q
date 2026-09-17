import { Session, SessionId } from "@q/domain/session/model"
import { DateTime } from "effect"

export const makeSessionId = (id = "00000000-0000-4000-8000-000000000000"): SessionId => SessionId.make(id)

export const makeSession = (overrides: Partial<Session> = {}): Session =>
  Session.make({
    id: makeSessionId(),
    cwd: "/test",
    createdAt: DateTime.makeUnsafe(0),
    ...overrides,
  })
