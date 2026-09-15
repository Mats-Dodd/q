import { HttpApi } from "effect/unstable/httpapi"

import { SessionsGroup } from "./sessions/group"

export class Api extends HttpApi.make("q").add(SessionsGroup) {}
