// @q/core — the agent program without a screen. Any front end takes `program` from here.

// Domain: pure schemas, no services.
export { ConversationEvent, Outcome } from "./domain/event"
export { ChatMessage, Model, Role, Turn } from "./domain/model"

// Services: tags with their in-memory Layers.
export { Agent, AgentError, EchoAgent, makeEchoAgent } from "./services/agent"
export { InMemoryTranscript, Transcript, TranscriptError, makeInMemoryTranscript } from "./services/transcript"

// Program: messages, commands, update, subscriptions.
export { AcceptPrompt, CommitTurn } from "./command"
export { Message } from "./message"
export { program } from "./program"
export { AgentTurn, coalesce } from "./subscription"
export { type Flags, init, update } from "./update"
