# effect-ai-ui

The [AI SDK UI message stream protocol](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol) for Effect's `effect/unstable/ai`.

Effect gives you `LanguageModel.streamText` and a `Toolkit`. The AI SDK gives you `useChat`, `UIMessage` and a wire format every AI frontend understands. This package is the adapter between them, with the message and chunk schemas typed from your toolkit.

```ts
import { LanguageModel, Prompt } from "effect/unstable/ai"
import { convertToModelMessages } from "effect-ai-ui/ModelMessages"
import { toUIMessageStream } from "effect-ai-ui/UIMessageStream"
import { toSseStream } from "effect-ai-ui/Sse"

// One step: UIMessage[] in, an SSE body out.
const step = (messages: ReadonlyArray<UIMessage<typeof MyToolkit.tools>>) =>
  LanguageModel.streamText({ prompt: convertToModelMessages(messages), toolkit: MyToolkitWithHandlers }).pipe(
    toUIMessageStream(MyToolkit),
    toSseStream,
  )
```

## Modules

| Module                          | What it is                                                                                                                                                                                    |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `effect-ai-ui/UIMessage`        | `UIMessage(toolkit)`, `UIMessagePart(toolkit)`, `ToolUIPart(name, parameters, success)`. A `tool-${name}` part per tool, `input` and `output` in the tool's encoded (JSON) form.              |
| `effect-ai-ui/UIMessageChunk`   | `UIMessageChunk(toolkit)`: the wire protocol, one schema per chunk type.                                                                                                                      |
| `effect-ai-ui/UIMessageStream`  | `toUIMessageStream(toolkit)`: Effect `Response.StreamPart`s to chunks, wrapped in `start-step` and `finish-step`.                                                                             |
| `effect-ai-ui/UIMessageReducer` | `applyChunk`, `readUIMessageStream`, `foldUIMessageStream`, `finalize`, `emptyAssistant`: chunks to a `UIMessage`. Pure; a chunk that fits nothing is a `UIMessageStreamError` in a `Result`. |
| `effect-ai-ui/ModelMessages`    | `convertToModelMessages`: `UIMessage[]` to `Prompt.Prompt`.                                                                                                                                   |
| `effect-ai-ui/Sse`              | `toSseStream`, `fromSseStream(toolkit)`, `UI_MESSAGE_STREAM_HEADERS`.                                                                                                                         |

## Typed tool parts

```ts
const part = message.parts[0]
if (part.type === "tool-get_weather" && part.state === "output-available") {
  part.input.city // string
  part.output.temperatureC // number
}
```

The shapes come from the `Toolkit`, so definition and rendering share one source of truth. A tool the toolkit does not know, or a `Tool.Dynamic`, is a `dynamic-tool` part with `input: unknown`.

## Where it differs from the AI SDK

- Text parts carry an optional `id`. The reducer is pure over the message alone; the part must know which stream it belongs to. `useChat` ignores the field.
- `input-streaming` carries no partial `input`. Partial JSON is not parsed.
- A denied approval in `approval-responded` state converts to the approval response only. Effect's `LanguageModel` writes the `execution-denied` result itself on the next call.
- No `metadata`, `data-*` or `custom` parts yet.

## One step, not the loop

`toUIMessageStream` wraps one `LanguageModel.streamText` call. The agent loop that reads the tool results and calls the model again is yours; so are the `start` and `finish` chunks around the whole message. `finishChunk(reason)` maps Effect's finish reason to the protocol's.

## Invariant

For any one step, `convertToModelMessages([fold(toUIMessageStream(parts))])` equals `Prompt.fromResponseParts(parts)`. The property test in `model-messages.test.ts` pins it.
