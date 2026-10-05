import { BunServices } from "@effect/platform-bun"
import { layer } from "@effect/vitest"
import { strictEqual } from "@effect/vitest/utils"
import { Effect, FileSystem } from "effect"
import { fixtures, render } from "./support/Golden.ts"

layer(BunServices.layer)("golden session transcripts", (it) => {
  it.effect("are up to date with what the AI SDK makes of each fixture (run `bun run fixtures`)", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      for (const fixture of yield* fixtures) {
        strictEqual(yield* fs.readFileString(fixture.transcriptFile), render(fixture.transcript), fixture.name)
      }
    }))
})
