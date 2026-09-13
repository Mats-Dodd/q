// @q/core — the agent program without a screen. Any front end takes `program` from here.

// Domain: pure schemas, no services.
export { ConversationEvent, Outcome } from "./domain/event"
export { ChatMessage, Model, Role, Turn } from "./domain/model"
export { Session, SessionId } from "./domain/session"

// Services: tags with their Layers. Storage is bound to a concrete `SqlClient` by the composition root.
export { Agent, AgentError, EchoAgent, makeEchoAgent } from "./services/agent"
export { SqlTranscriptRepository, TranscriptRepository } from "./services/repository"
export { Resume, SessionTranscript, Transcript, TranscriptError } from "./services/transcript"

// Program: messages, commands, update, subscriptions.
export { AcceptPrompt, CommitTurn } from "./command"
export { Message } from "./message"
export { program } from "./program"
export { AgentTurn, coalesce } from "./subscription"
export { type Flags, init, update } from "./update"
