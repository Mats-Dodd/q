import { Schema } from "effect"

import { SessionId } from "./model"

export class SessionNotFoundError extends Schema.TaggedError<SessionNotFoundError>()(
  "SessionNotFoundError",
  { sessionId: SessionId },
  { httpApiStatus: 404 },
) {}
