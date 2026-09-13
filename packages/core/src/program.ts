import { Effect } from "effect"

import type { Program } from "@q/kit"
import type { Model } from "./domain/model"
import type { Message } from "./message"
import type { Agent } from "./services/agent"
import { Transcript } from "./services/transcript"
import { AgentTurn } from "./subscription"
import { type Flags, init, update } from "./update"

// PROGRAM — the whole agent, headless. Front ends and tests take it from here; the binary picks the Layers.

/** Load the durable conversation. An unreadable transcript starts an empty session rather than crashing. */
const flags: Effect.Effect<Flags, never, Transcript> = Effect.flatMap(Transcript, (transcript) => transcript.load).pipe(
  Effect.map((events) => ({ events })),
  Effect.catch(() => Effect.succeed({ events: [] })),
)

export const program: Program.Program<Model, Message, Agent | Transcript, Flags> = {
  flags,
  init,
  update,
  subscriptions: { agentTurn: AgentTurn },
}
