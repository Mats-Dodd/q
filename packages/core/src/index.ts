// @q/core — the agent program without a screen. Any front end takes `program` from here.

export { Agent, AgentError, EchoAgent, makeEchoAgent } from "./agent"
export { AcceptPrompt, CommitTurn } from "./command"
export { Message } from "./message"
export { ChatMessage, Model, Role, Turn } from "./model"
export { program } from "./program"
export { AgentTurn, coalesce } from "./subscription"
export {
  ConversationEvent,
  InMemoryTranscript,
  Outcome,
  Transcript,
  TranscriptError,
  makeInMemoryTranscript,
} from "./transcript"
export { type Flags, init, update } from "./update"
