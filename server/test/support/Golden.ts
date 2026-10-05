import { readUIMessageStream, type UIMessage, uiMessageChunkSchema } from "ai"
import { convertArrayToReadableStream } from "ai/test"
import { Array, Effect, FileSystem, Option, Order, Path, Result, Schema, Stream } from "effect"
import { StreamChunk } from "../../src/domain/StreamChunk.ts"

/**
 * Golden session transcripts: what a client should make of a session stream,
 * computed by the AI SDK itself. Each fixture in `test/fixtures/sessions` is a
 * `<name>.jsonl` stream (one chunk per line) and a `<name>.turns.json`
 * holding its turns. Clients (the Rust TUI) fold the same streams and must
 * produce the same JSON. Regenerate with `bun run fixtures`.
 */
export const fixturesDir = "test/fixtures/sessions"

/** One user message and everything the stream says about the reply to it. */
export interface GoldenTurn {
  readonly id: string
  readonly text: string
  /** The assistant message the AI SDK builds from the turn's chunks. */
  readonly reply: UIMessage | null
  /** `errorText` of every `error` chunk. */
  readonly errors: ReadonlyArray<string>
  /** How the turn ended; `null` while it runs. */
  readonly end: string | null
}

const ChunkLine = Schema.fromJsonString(Schema.toCodecJson(StreamChunk))

/** A chunk as the AI SDK sees it: validated (and typed) by its own schema. */
const toAiSdkChunk = (chunk: StreamChunk) =>
  Schema.encodeEffect(Schema.toCodecJson(StreamChunk))(chunk).pipe(
    Effect.flatMap((json) => Effect.promise(() => Promise.resolve(uiMessageChunkSchema().validate?.(json)))),
    Effect.flatMap((result) =>
      result?.success === true ? Effect.succeed(result.value) : Effect.die(`not an AI SDK chunk: ${chunk.type}`)
    ),
    Effect.orDie
  )

/** The reply the AI SDK builds from a turn's (non-data) chunks: its last update. */
const replyOf = (chunks: ReadonlyArray<StreamChunk>) =>
  Effect.forEach(chunks, toAiSdkChunk).pipe(
    Effect.flatMap((aiSdkChunks) =>
      Stream.fromAsyncIterable(
        readUIMessageStream({ stream: convertArrayToReadableStream(aiSdkChunks) }),
        (error) => error
      ).pipe(Stream.runLast, Effect.map(Option.getOrNull), Effect.orDie)
    )
  )

interface Pending {
  readonly id: string
  readonly text: string
  readonly chunks: ReadonlyArray<StreamChunk>
  readonly errors: ReadonlyArray<string>
  readonly end: string | null
}

/** Splits a session stream into turns, each started by its `data-user-message`. */
const turnsOf = (chunks: ReadonlyArray<StreamChunk>) =>
  Array.reduce(chunks, [] as ReadonlyArray<Pending>, (turns, chunk) => {
    if (chunk.type === "data-user-message") {
      return [...turns, { id: chunk.id, text: chunk.data.text, chunks: [], errors: [], end: null }]
    }
    const current = turns.at(-1)
    if (current === undefined) {
      return turns
    }
    const updated: Pending = chunk.type === "data-turn-end"
      ? { ...current, end: chunk.data.reason }
      : chunk.type === "data-turn-start"
      ? current
      : chunk.type === "error"
      ? { ...current, errors: [...current.errors, chunk.errorText] }
      : { ...current, chunks: [...current.chunks, chunk] }
    return [...turns.slice(0, -1), updated]
  })

export const transcriptOf = (chunks: ReadonlyArray<StreamChunk>) =>
  Effect.forEach(turnsOf(chunks), (turn) =>
    replyOf(turn.chunks).pipe(
      Effect.map((reply): GoldenTurn => ({ id: turn.id, text: turn.text, reply, errors: turn.errors, end: turn.end }))
    ))

/** Every fixture: its name, its decoded chunks, and the transcript the AI SDK makes of them. */
export const fixtures = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const names = Array.sort(
    Array.filterMap(yield* fs.readDirectory(fixturesDir), (file) =>
      file.endsWith(".jsonl") ? Result.succeed(file.slice(0, -".jsonl".length)) : Result.failVoid),
    Order.String
  )
  return yield* Effect.forEach(names, (name) =>
    Effect.gen(function*() {
      const text = yield* fs.readFileString(path.join(fixturesDir, `${name}.jsonl`))
      const lines = text.split("\n").filter((line) => line.length > 0)
      const chunks = yield* Effect.forEach(lines, (line) => Schema.decodeEffect(ChunkLine)(line))
      return {
        name,
        chunks,
        transcriptFile: path.join(fixturesDir, `${name}.turns.json`),
        transcript: yield* transcriptOf(chunks)
      }
    }))
})

export const render = (transcript: ReadonlyArray<GoldenTurn>) => JSON.stringify(transcript, null, 2) + "\n"
