import type { Session } from "@q/domain/session/model"
import { Context } from "effect"

/** The session a program is running for. Provided per runtime by the session-runtime module. */
export class CurrentSession extends Context.Service<CurrentSession, Session>()("@q/core/session/current-session/CurrentSession") {}
