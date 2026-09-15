import { Command } from "effect/unstable/cli"

import { listCommand } from "./list"

export const sessionsCommand = Command.make("sessions").pipe(
  Command.withSubcommands([listCommand]),
  Command.withDescription("Inspect the sessions in this directory."),
)
