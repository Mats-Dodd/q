import { FileSystem, Layer, Path } from "effect"
import { Etag, HttpPlatform } from "effect/unstable/http"

/** What `HttpApiTest.groups` needs to route a request in memory: no socket, no real file system. */
export const HttpPlatformLayerTest = Layer.mergeAll(Path.layer, Etag.layerWeak, HttpPlatform.layer).pipe(
  Layer.provideMerge(FileSystem.layerNoop({})),
)
