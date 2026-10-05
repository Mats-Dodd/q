import { Array, Data, Function } from "effect"
import type { Response } from "effect/ai"
import type { SessionEvent } from "./SessionEvent.ts"
import type { TurnId } from "./Turn.ts"

/** What the agent loop produces while it works: step boundaries, and the model's raw output. */
export type AgentOutput = Data.TaggedEnum<{
  StepStarted: {}
  Part: { readonly part: Response.StreamPart<{}> }
}>
export const AgentOutput = Data.taggedEnum<AgentOutput>()

/** The events a run of a turn's output becomes: consecutive parts are one `ModelOutput`. */
export const eventsOf: {
  (turnId: TurnId): (outputs: ReadonlyArray<AgentOutput>) => ReadonlyArray<SessionEvent>
  (outputs: ReadonlyArray<AgentOutput>, turnId: TurnId): ReadonlyArray<SessionEvent>
} = Function.dual(2, (outputs: ReadonlyArray<AgentOutput>, turnId: TurnId): ReadonlyArray<SessionEvent> =>
  Array.reduce(outputs, [] as ReadonlyArray<SessionEvent>, (events, output) => {
    if (output._tag === "StepStarted") {
      return [...events, { _tag: "StepStarted", turnId }]
    }
    const last = events.at(-1)
    return last?._tag === "ModelOutput"
      ? [...events.slice(0, -1), { ...last, parts: [...last.parts, output.part] }]
      : [...events, { _tag: "ModelOutput", turnId, parts: [output.part] }]
  }))
