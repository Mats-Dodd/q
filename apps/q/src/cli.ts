import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { Command } from "effect/unstable/cli"

import { chatCommand } from "./commands/chat"
import { serveCommand } from "./commands/serve"
import { sessionsCommand } from "./commands/sessions/sessions"

const version = "0.0.0"

const cli = chatCommand.pipe(Command.withSubcommands([serveCommand, sessionsCommand]))

// The process entry point: the one place where Layers are provided.
// @effect-diagnostics-next-line strictEffectProvide:off
Command.run(cli, { version }).pipe(Effect.provide(BunServices.layer), BunRuntime.runMain())
