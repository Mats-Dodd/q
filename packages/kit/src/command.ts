import { Effect, Stream } from "effect"

/**
 * An effect that produces Messages. Commands are data: `update` returns them, the runtime forks
 * them, tests inspect them by name without running them. Most Commands produce exactly one Message
 * (`define`); a streaming Command produces many (`defineStream`), each dispatched as it arrives.
 * Failures must be turned into `Failed*` Messages inside the definition; the error channel is `never`.
 */
export interface Command<Msg, R = never> {
  readonly name: string
  readonly args: Record<string, unknown> | undefined
  readonly stream: Stream.Stream<Msg, never, R>
}

type Args = Record<string, unknown>

export type Definition<Name extends string, A extends Args, Msg, R> = {
  readonly name: Name
} & (keyof A extends never ? () => Command<Msg, R> : (args: A) => Command<Msg, R>)

const named = <Name extends string, A extends Args, Msg, R>(name: Name, make: (args?: A) => Command<Msg, R>): Definition<Name, A, Msg, R> =>
  Object.defineProperty(make, "name", { value: name }) as unknown as Definition<Name, A, Msg, R>

/**
 * Define a named Command that produces one Message. `execute` is wrapped in `Effect.suspend`, so
 * constructing a Command inside `update` never runs anything.
 *
 *   const DelayReset = Command.define("DelayReset", ({ seconds }: { seconds: number }) =>
 *     Effect.as(Effect.sleep(`${seconds} seconds`), Message.cases.CompletedDelayReset.make({})))
 */
export const define = <const Name extends string, A extends Args, Msg, R = never>(
  name: Name,
  execute: (args: A) => Effect.Effect<Msg, never, R>,
): Definition<Name, A, Msg, R> =>
  named(name, (args?: A) => ({
    name,
    args,
    stream: Stream.fromEffect(Effect.suspend(() => execute((args ?? {}) as A))),
  }))

/**
 * Define a named Command that produces a stream of Messages. Each element is dispatched as it
 * arrives, in order. The stream ends when the work is done; end it with a terminal Message if the
 * program needs to know.
 */
export const defineStream = <const Name extends string, A extends Args, Msg, R = never>(
  name: Name,
  execute: (args: A) => Stream.Stream<Msg, never, R>,
): Definition<Name, A, Msg, R> =>
  named(name, (args?: A) => ({
    name,
    args,
    stream: Stream.suspend(() => execute((args ?? {}) as A)),
  }))

/** Lift a Command's Messages into another Message type (used when composing child programs). */
export const mapMessage = <A, B, R>(command: Command<A, R>, f: (message: A) => B): Command<B, R> => ({
  ...command,
  stream: Stream.map(command.stream, f),
})

export const mapMessages = <A, B, R>(
  commands: ReadonlyArray<Command<A, R>> | undefined,
  f: (message: A) => B,
): ReadonlyArray<Command<B, R>> => (commands ?? []).map((command) => mapMessage(command, f))
