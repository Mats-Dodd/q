import { BunServices } from "@effect/platform-bun"
import { layer } from "@effect/vitest"
import { strictEqual } from "@effect/vitest/utils"
import { Effect, FileSystem } from "effect"
import { artifacts, render } from "../src/codegen/Codegen.ts"

layer(BunServices.layer)("generated artifacts", (it) => {
  for (const [file, document] of Object.entries(artifacts())) {
    it.effect(`${file} is up to date (run \`bun run codegen\`)`, () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        strictEqual(yield* fs.readFileString(file), render(document))
      }))
  }
})
