/**
 * Writes every generated artifact (`generated/wire.schema.json`,
 * `generated/openapi.json`). `test/Codegen.test.ts` fails when they drift.
 *
 * The Rust client generates its types from `generated/wire.schema.json` (its `build.rs`).
 */
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Path } from "effect"
import { artifacts, render } from "../src/codegen/Codegen.ts"

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  yield* Effect.forEach(Object.entries(artifacts()), ([file, document]) =>
    fs.makeDirectory(path.dirname(file), { recursive: true }).pipe(
      Effect.andThen(fs.writeFileString(file, render(document))),
      Effect.andThen(Effect.log(`wrote ${file}`))
    ), { discard: true })
})

program.pipe(
  // oxlint-disable-next-line effecttsgo/strict-effect-provide -- script entry point
  Effect.provide(BunServices.layer),
  BunRuntime.runMain
)
