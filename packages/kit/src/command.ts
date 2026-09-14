import { Effect } from "effect"

/**
 * A one-shot effect that produces exactly one Message. Commands are data: `update`
 * returns them, the runtime forks them, tests inspect them by name without running them.
 * Failures must be turned into `Failed*` Messages inside `execute`; the error channel is `never`.
 */
export interface Command<Msg, R = never> {
  readonly name: string
  readonly args: Record<string, unknown> | undefined
  readonly effect: Effect.Effect<Msg, never, R>
}

type Args = Record<string, unknown>

export type Definition<Name extends string, A extends Args, Msg, R> = {
  readonly name: Name
} & (keyof A extends never ? () => Command<Msg, R> : (args: A) => Command<Msg, R>)

/**
 * Define a named Command. `execute` is wrapped in `Effect.suspend`, so constructing a
 * Command inside `update` never runs anything.
 *
 *   const DelayReset = Command.define("DelayReset", ({ seconds }: { seconds: number }) =>
 *     Effect.as(Effect.sleep(`${seconds} seconds`), Message.cases.CompletedDelayReset.make({})))
 */
export const define = <const Name extends string, A extends Args, Msg, R = never>(
  name: Name,
  execute: (args: A) => Effect.Effect<Msg, never, R>,
): Definition<Name, A, Msg, R> => {
  const make = (args?: A): Command<Msg, R> => ({
    name,
    args,
    effect: Effect.suspend(() => execute((args ?? {}) as A)),
  })
  return Object.defineProperty(make, "name", { value: name }) as unknown as Definition<Name, A, Msg, R>
}

/** Lift a Command's result Message into another Message type (used when composing child programs). */
export const mapMessage = <A, B, R>(command: Command<A, R>, f: (message: A) => B): Command<B, R> => ({
  ...command,
  effect: Effect.map(command.effect, f),
})

export const mapMessages = <A, B, R>(
  commands: ReadonlyArray<Command<A, R>> | undefined,
  f: (message: A) => B,
): ReadonlyArray<Command<B, R>> => (commands ?? []).map((command) => mapMessage(command, f))
