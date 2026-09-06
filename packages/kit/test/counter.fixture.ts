import { Effect, Schema, Struct } from "effect"

import * as Command from "../src/command"
import type { Program, Return } from "../src/program"
import { defineMessageUnion } from "../src/schema"

/** A tiny program with one Command, used by the kit's own tests. Mirrors Foldkit's counter. */

export const Model = Schema.Struct({ count: Schema.Number, isResetting: Schema.Boolean })
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  ClickedIncrement: {},
  ClickedResetAfterDelay: { seconds: Schema.Number },
  CompletedDelayReset: {},
})
export type Message = typeof Message.Type

export const DelayReset = Command.define("DelayReset", ({ seconds }: { seconds: number }) =>
  Effect.as(Effect.sleep(`${seconds} seconds`), Message.CompletedDelayReset()),
)

export const init = (): Return<Model, Message> => ({ model: { count: 0, isResetting: false } })

export const update = (model: Model, message: Message): Return<Model, Message> =>
  Message.match(message, {
    ClickedIncrement: () => ({ model: Struct.evolve(model, { count: (n) => n + 1 }) }),
    ClickedResetAfterDelay: ({ seconds }) => ({
      model: Struct.evolve(model, { isResetting: () => true }),
      commands: [DelayReset({ seconds })],
    }),
    CompletedDelayReset: () => ({ model: { count: 0, isResetting: false } }),
  })

export const program: Program<Model, Message> = { flags: Effect.void, init, update }
