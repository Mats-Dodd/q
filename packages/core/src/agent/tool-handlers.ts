import { AgentToolkit } from "@q/domain/agent/tools"
import { Effect } from "effect"

// TOOL HANDLERS — what each tool does when the model calls it. Stand-ins with fixed answers: the loop is the point.

const WEATHER: Record<string, { readonly temperatureC: number; readonly sky: string }> = {
  london: { temperatureC: 14, sky: "overcast" },
  oslo: { temperatureC: 6, sky: "clear" },
  "san francisco": { temperatureC: 17, sky: "fog" },
  sydney: { temperatureC: 22, sky: "sunny" },
  tokyo: { temperatureC: 24, sky: "rain" },
}

export const AgentToolHandlers = AgentToolkit.toLayer({
  get_weather: ({ city }) => {
    const known = WEATHER[city.trim().toLowerCase()]
    return known === undefined ? Effect.fail({ unknownCity: city }) : Effect.succeed({ city, ...known })
  },
  // Approval happened before this runs; the model never sees this handler without it.
  send_email: ({ to }) => Effect.succeed({ sent: true, to }),
})
