/**
 * Writes the golden transcript of every session stream fixture
 * (`test/fixtures/sessions/<name>.turns.json`), computed by the AI SDK.
 * `test/Golden.test.ts` fails when they drift; the Rust client's fold is
 * tested against the same files.
 */
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Effect, FileSystem } from "effect"
import { fixtures, render } from "../test/support/Golden.ts"

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  for (const fixture of yield* fixtures) {
    yield* fs.writeFileString(fixture.transcriptFile, render(fixture.transcript))
    yield* Effect.log(`wrote ${fixture.transcriptFile}`)
  }
})

program.pipe(
  // oxlint-disable-next-line effecttsgo/strict-effect-provide -- script entry point
  Effect.provide(BunServices.layer),
  BunRuntime.runMain
)
