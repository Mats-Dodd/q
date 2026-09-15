import type * as Runtime from "@q/kit/runtime"
import { Effect, Stream } from "effect"

/**
 * Fork a wait for the first Message that satisfies `predicate`. Fork before the dispatch that
 * causes it, join after: completion is a message on the runtime, never a sleep.
 */
export const awaiting = <Model, Message>(runtime: Runtime.Runtime<Model, Message>, predicate: (message: Message) => boolean) =>
  Effect.forkChild(Stream.runHead(Stream.filter(runtime.messages, predicate)), { startImmediately: true })
