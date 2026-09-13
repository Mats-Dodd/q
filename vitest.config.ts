import solid from "vite-plugin-solid"
import { defineConfig } from "vitest/config"

// Tests run on Bun (`bun --bun vitest`): OpenTUI's FFI and `bun:sqlite` need it. The Solid transform
// mirrors `@opentui/solid/bun-plugin`: OpenTUI's universal renderer, and Solid's client build (the
// `node` export condition would pick the server build).
export default defineConfig({
  plugins: [solid({ solid: { moduleName: "@opentui/solid", generate: "universal" } })],
  resolve: {
    alias: [
      { find: /^solid-js$/, replacement: "solid-js/dist/solid.js" },
      { find: /^solid-js\/store$/, replacement: "solid-js/store/dist/store.js" },
    ],
  },
  test: {
    environment: "node",
    include: ["packages/*/test/**/*.test.{ts,tsx}"],
  },
})
