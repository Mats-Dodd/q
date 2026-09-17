import type * as Program from "@q/kit/program"
import { Effect } from "effect"

import type { Transport } from "@q/client/transport/transport-service"
import type { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"

export const program: Program.Program<Model, Message, Transport> = { flags: Effect.void, init, update }
