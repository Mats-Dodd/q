import type { Effect } from "effect"

import type { Command } from "./command"
import type { Subscription } from "./subscription"

/** What `init` and `update` return: the next Model and any Commands to run. */
export interface Return<Model, Msg, R = never> {
  readonly model: Model
  readonly commands?: ReadonlyArray<Command<Msg, R>>
}

export type Update<Model, Msg, R = never> = (model: Model, message: Msg) => Return<Model, Msg, R>

/**
 * A complete Elm program. `flags` runs once at boot (loading durable state, for example),
 * `init` folds them into the first Model, `update` is the only way the Model changes, and
 * `subscriptions` are Model-gated streams of Messages.
 */
export interface Program<Model, Msg, R = never, Flags = void> {
  readonly flags: Effect.Effect<Flags, never, R>
  readonly init: (flags: Flags) => Return<Model, Msg, R>
  readonly update: Update<Model, Msg, R>
  readonly subscriptions?: Readonly<Record<string, Subscription<Model, Msg, R>>>
}
