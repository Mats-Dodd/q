import solidPlugin from "@opentui/solid/bun-plugin"

const result = await Bun.build({
  entrypoints: [`${import.meta.dir}/src/cli.ts`],
  target: "bun",
  plugins: [solidPlugin],
  minify: true,
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  external: [
    "@opentui/core-darwin-x64",
    "@opentui/core-linux-arm64",
    "@opentui/core-linux-arm64-musl",
    "@opentui/core-linux-x64",
    "@opentui/core-linux-x64-musl",
    "@opentui/core-win32-arm64",
    "@opentui/core-win32-x64",
  ],
  compile: {
    target: "bun-darwin-arm64",
    outfile: `${import.meta.dir}/dist/q`,
    autoloadDotenv: false,
    autoloadBunfig: false,
    autoloadPackageJson: false,
  },
})

if (!result.success) {
  for (const message of result.logs) console.error(message)
  process.exit(1)
}

console.log("Built dist/q")
