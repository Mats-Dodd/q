import { it } from "@effect/vitest"
import { assertEquals, assertTrue, deepStrictEqual } from "@effect/vitest/utils"
import { Effect, Schema } from "effect"
import { StreamChunk } from "../src/domain/StreamChunk.ts"
import { aiSdkChunksForText, isAiSdkChunk } from "./support/AiSdkReference.ts"

/** `StreamChunk` to and from the exact JSON text stored and served. */
const StreamChunkJsonText = Schema.fromJsonString(Schema.toCodecJson(StreamChunk))

it.effect.prop("StreamChunk survives a JSON round trip", { chunk: StreamChunk }, ({ chunk }) =>
  Effect.gen(function*() {
    const text = yield* Schema.encodeEffect(StreamChunkJsonText)(chunk)
    assertEquals(yield* Schema.decodeEffect(StreamChunkJsonText)(text), chunk)
  }))

it.effect.prop("every StreamChunk is a UI message chunk the AI SDK accepts", { chunk: StreamChunk }, ({ chunk }) =>
  Effect.gen(function*() {
    const json = yield* Schema.encodeEffect(Schema.toCodecJson(StreamChunk))(chunk)
    assertTrue(yield* isAiSdkChunk(json))
  }))

it.effect("decodes the chunks the AI SDK emits for a streamed text response", () =>
  Effect.gen(function*() {
    const emitted = yield* aiSdkChunksForText(["Hello", ", ", "world"])
    const decoded = yield* Effect.forEach(emitted, (chunk) => Schema.decodeUnknownEffect(StreamChunk)(chunk))
    deepStrictEqual(decoded.map((chunk) => chunk.type), [
      "start",
      "start-step",
      "text-start",
      "text-delta",
      "text-delta",
      "text-delta",
      "text-end",
      "finish-step",
      "finish"
    ])
  }))
