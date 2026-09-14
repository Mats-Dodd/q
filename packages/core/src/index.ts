// @q/core — the agent program without a screen, and the contract a client uses to reach it.
// Pure: schemas, the Elm program, service tags. Storage and hosting live in @q/server.

// Domain: pure schemas, no services.
export { ConversationEvent, Outcome } from "./domain/event"
export { ChatMessage, Model, Role, Turn } from "./domain/model"
export { Session, SessionId } from "./domain/session"

// Services: tags with their pure Layers as statics (`Agent.Echo`, `TranscriptRepository.Memory`,
// `Transcript.Session`). Durable storage is bound to a `SqlClient` in @q/server.
export { Agent, AgentError } from "./services/agent"
export { TranscriptRepository } from "./services/repository"
export { Resume, Transcript, TranscriptError } from "./services/transcript"

// Program: messages, commands, update, subscriptions.
export { AcceptPrompt, CommitTurn } from "./command"
export { Message } from "./message"
export { program } from "./program"
export { AgentTurn, coalesce } from "./subscription"
export { type Flags, init, update } from "./update"

// API: the HTTP contract between a client and the server.
export { Api, Intent, ModelStream, SessionNotFound, Sessions, StorageFailed } from "./api"
