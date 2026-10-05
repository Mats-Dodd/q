import { Array, Result } from "effect"
import { Prompt, Response } from "effect/ai"

/**
 * What goes into a session's model log: the conversation as the model sees
 * it, with everything providers need back (reasoning signatures, tool call ids,
 * provider options), which the client-facing stream does not carry.
 */

export const userMessage = (text: string): Prompt.Message => Prompt.userMessage({ content: [Prompt.makePart("text", { text })] })

/**
 * The model's reply as messages to remember, from the parts it streamed.
 * A reply cut short keeps its unfinished text (the user saw it); unfinished
 * reasoning is dropped, since providers reject reasoning they did not sign.
 */
export const replyMessages = (parts: ReadonlyArray<Response.StreamPart<{}>>): ReadonlyArray<Prompt.Message> => {
  const ended = new Set(Array.filterMap(parts, (part) => part.type === "text-end" ? Result.succeed(part.id) : Result.failVoid))
  const unfinished = Array.filterMap(parts, (part) =>
    part.type === "text-start" && !ended.has(part.id)
      ? Result.succeed(Response.makePart("text-end", { id: part.id }))
      : Result.failVoid)
  return Prompt.fromResponseParts([...parts, ...unfinished]).content
}
