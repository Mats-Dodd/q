import { type Agent, EchoAgent, InMemoryTranscript, type Transcript } from "@q/core"
import { Layer } from "effect"

/** The services the binary runs with today. Swap Layers here; the program does not change. */
export const AppLayer: Layer.Layer<Agent | Transcript> = Layer.mergeAll(EchoAgent, InMemoryTranscript)
