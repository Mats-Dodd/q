import type { ConversationModel } from "@q/domain/conversation/model"
import type * as Program from "@q/kit/program"
import { Effect } from "effect"

import type { AgentService } from "../agent/agent-service"
import { CurrentSession } from "../session/current-session"
import { TranscriptService } from "../transcript/transcript-service"
import type { Message } from "./message"
import { AgentTurn } from "./subscription"
import { type Flags, init, update } from "./update"

// PROGRAM — the whole agent, headless. Front ends and tests take it from here; the binary picks the Layers.

/** Load the durable conversation. An unreadable transcript starts an empty session rather than crashing. */
const flags: Effect.Effect<Flags, never, CurrentSession | TranscriptService> = Effect.gen(function* flags() {
  const { id } = yield* CurrentSession
  const transcript = yield* TranscriptService
  return { events: yield* transcript.load(id) }
}).pipe(Effect.orElseSucceed(() => ({ events: [] })))

export const program: Program.Program<ConversationModel, Message, AgentService | CurrentSession | TranscriptService, Flags> = {
  flags,
  init,
  update,
  subscriptions: { agentTurn: AgentTurn },
}
