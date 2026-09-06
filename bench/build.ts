import solidPlugin from "@opentui/solid/bun-plugin"

// OpenTUI currently uses top-level await, which Bun 1.4 cannot emit as
// bytecode. Compare the two supported standalone production variants.
const variants = [
  { name: "plain", minify: false },
  { name: "minify", minify: true },
] as const

const missingNativeTargets = [
  "@opentui/core-darwin-x64",
  "@opentui/core-linux-arm64",
  "@opentui/core-linux-arm64-musl",
  "@opentui/core-linux-x64",
  "@opentui/core-linux-x64-musl",
  "@opentui/core-win32-arm64",
  "@opentui/core-win32-x64",
]

await Bun.$`rm -rf dist/bench`
await Bun.$`mkdir -p dist/bench`

const apps = [
  { name: "core", entrypoint: "bench/core.ts", solid: false },
  { name: "solid", entrypoint: "bench/solid.tsx", solid: true },
  { name: "solid-parity", entrypoint: "bench/solid-parity.tsx", solid: true },
] as const

for (const app of apps) {
  for (const variant of variants) {
    const outfile = `dist/bench/${app.name}-${variant.name}`
    const result = await Bun.build({
      entrypoints: [app.entrypoint],
      target: "bun",
      plugins: app.solid ? [solidPlugin] : [],
      external: missingNativeTargets,
      minify: variant.minify,
      sourcemap: "none",
      define: {
        "process.env.NODE_ENV": JSON.stringify("production"),
      },
      compile: {
        target: "bun-darwin-arm64",
        outfile,
        autoloadDotenv: false,
        autoloadBunfig: false,
        autoloadPackageJson: false,
      },
    })

    if (!result.success) {
      for (const log of result.logs) console.error(log)
      throw new Error(`Failed to build ${app.name}-${variant.name}`)
    }

    console.log(`built ${outfile}`)
  }
}
