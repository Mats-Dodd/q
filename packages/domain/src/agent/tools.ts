import { Schema } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"

// AGENT TOOLS — the contract of every tool the agent may call: name, parameters, result. Handlers live in core.
// Everything typed by the toolkit (UI parts, chunks, transcript events) derives from this one value.

/** A stand-in tool with a fixed answer per city, so the loop can be exercised without a real backend. */
export const GetWeather = Tool.make("get_weather", {
  description: "The current weather in a city.",
  parameters: Schema.Struct({ city: Schema.String }),
  success: Schema.Struct({ city: Schema.String, temperatureC: Schema.Finite, sky: Schema.String }),
  failure: Schema.Struct({ unknownCity: Schema.String }),
  // An unknown city is an answer for the model, not a crash of the turn.
  failureMode: "return",
})

/** A tool with a side effect the user must approve first. It does not send anything; it reports that it would have. */
export const SendEmail = Tool.make("send_email", {
  description: "Send an email on the user's behalf. Requires the user's approval.",
  parameters: Schema.Struct({ to: Schema.String, subject: Schema.String, body: Schema.String }),
  success: Schema.Struct({ sent: Schema.Boolean, to: Schema.String }),
  needsApproval: true,
})

export const AgentToolkit = Toolkit.make(GetWeather, SendEmail)
export type AgentTools = typeof AgentToolkit.tools
