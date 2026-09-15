import { Schema } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"

// A small toolkit for the package's own tests. Two tools, so unions have more than one member; one
// with a structured failure in `"return"` mode, so failed results show up as `tool-output-error`.

export const GetWeather = Tool.make("get_weather", {
  description: "The weather in a city.",
  parameters: Schema.Struct({ city: Schema.String }),
  success: Schema.Struct({ temperatureC: Schema.Finite, sky: Schema.String }),
  failure: Schema.Struct({ unknownCity: Schema.String }),
  failureMode: "return",
})

const Echo = Tool.make("echo", {
  parameters: Schema.Struct({ text: Schema.String }),
  success: Schema.Struct({ text: Schema.String }),
})

export const WeatherToolkit = Toolkit.make(GetWeather, Echo)
