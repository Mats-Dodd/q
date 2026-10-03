import { Effect, Layer, Logger, Option } from "effect"
import { DevTools } from "effect/devtools"
import { ServerConfig } from "../ServerConfig.ts"

/**
 * Logging and tracing, chosen by `ServerConfig`:
 *
 * - logs go to the console, or as JSON to `logFile` when set (the TUI sets it
 *   when it spawns the server so logs never fight the terminal)
 * - every log line is also recorded as an event on the current span
 * - `devtools` streams spans to the Effect DevTools (VS Code extension)
 */
export const layer = Layer.unwrap(
  Effect.gen(function*() {
    const { devtools, logFile } = yield* ServerConfig

    const output = Option.match(logFile, {
      onNone: () => Logger.consolePretty(),
      onSome: (path) => Logger.toFile(Logger.formatJson, path)
    })
    const logger = Logger.layer([output, Logger.tracerLogger])

    return devtools ? Layer.merge(logger, DevTools.layer()) : logger
  })
)
