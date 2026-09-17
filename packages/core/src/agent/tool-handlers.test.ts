import { BunServices } from "@effect/platform-bun"
import { assert, describe, layer } from "@effect/vitest"
import { AgentToolkit, Bash, Edit, Read, Write } from "@q/domain/agent/tools"
import type { AgentTools } from "@q/domain/agent/tools"
import { Effect, FileSystem, Path, Schema, Stream } from "effect"
import type { Tool } from "effect/unstable/ai"

import { BASH_OUTPUT_LIMIT, BASH_TIMED_OUT_EXIT_CODE, READ_MAX_LINES, toolHandlers } from "./tool-handlers"

// The handlers against the real file system and a real shell, in a directory of their own.
// What the model gets back in each case, not how the OS is asked.

/** Call `name` with `params` as the model would, bound to `cwd`. The last result, in its JSON form. */
const call = <Name extends keyof AgentTools>(cwd: string, name: Name, params: Tool.ParametersEncoded<AgentTools[Name]>) =>
  Effect.gen(function* () {
    const toolkit = yield* Effect.provideContext(AgentToolkit, yield* toolHandlers(cwd))
    const results = yield* Stream.runCollect(yield* toolkit.handle(name, params))
    const last = results.at(-1)
    assert.isDefined(last)
    return { output: last.encodedResult, isFailure: last.isFailure }
  })

/** A fresh directory with `files` in it, gone when the test's scope closes. */
const workspace = (files: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    // macOS puts temp directories behind a symlink; the real path is what `pwd` prints.
    const cwd = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "q-tools-" }))
    for (const [name, content] of Object.entries(files)) {
      yield* fs.makeDirectory(path.dirname(path.join(cwd, name)), { recursive: true })
      yield* fs.writeFileString(path.join(cwd, name), content)
    }
    return { cwd, fs, path, at: (name: string) => path.join(cwd, name) }
  })

/** The output as the tool's success or failure schema says it is. */
const decoded = <S extends Schema.Top>(schema: S, output: unknown) => Schema.decodeUnknownEffect(schema)(output)

const reasonOf = <S extends Schema.Top & { readonly Type: { readonly reason: string } }>(schema: S, output: unknown) =>
  Effect.map(decoded(schema, output), (failure) => failure.reason)

layer(BunServices.layer, { excludeTestServices: true })("tool handlers", (it) => {
  describe("read", () => {
    it.effect("returns the file, one line per line, and where it is", () =>
      Effect.gen(function* () {
        const ws = yield* workspace({ "a.txt": "one\ntwo\nthree\n" })
        const { output, isFailure } = yield* call(ws.cwd, "read", { path: "a.txt" })
        assert.isFalse(isFailure)
        assert.deepStrictEqual(output, { path: ws.at("a.txt"), content: "one\ntwo\nthree\n", totalLines: 3, truncated: false })
      }),
    )

    it.effect("offset and limit pick a window; the total still counts the whole file", () =>
      Effect.gen(function* () {
        const ws = yield* workspace({ "a.txt": "1\n2\n3\n4\n5" })
        const { output } = yield* call(ws.cwd, "read", { path: "a.txt", offset: 2, limit: 2 })
        assert.deepStrictEqual(output, { path: ws.at("a.txt"), content: "2\n3\n", totalLines: 5, truncated: false })
      }),
    )

    it.effect("a file past the line cap is cut and says so", () =>
      Effect.gen(function* () {
        const ws = yield* workspace({ "big.txt": Array.from({ length: READ_MAX_LINES + 5 }, (_, i) => `${i}`).join("\n") })
        const { output } = yield* call(ws.cwd, "read", { path: "big.txt" })
        const { content, totalLines, truncated } = yield* decoded(Read.successSchema, output)
        assert.isTrue(truncated)
        assert.strictEqual(totalLines, READ_MAX_LINES + 5)
        assert.strictEqual(content.split("\n").length - 1, READ_MAX_LINES)
      }),
    )

    it.effect("a missing file and a directory are failures the model can read", () =>
      Effect.gen(function* () {
        const ws = yield* workspace({ "dir/x": "" })
        const missing = yield* call(ws.cwd, "read", { path: "nope.txt" })
        assert.isTrue(missing.isFailure)
        assert.strictEqual(yield* reasonOf(Read.failureSchema, missing.output), "not-found")
        const dir = yield* call(ws.cwd, "read", { path: "dir" })
        assert.isTrue(dir.isFailure)
        assert.strictEqual(yield* reasonOf(Read.failureSchema, dir.output), "not-a-file")
      }),
    )
  })

  describe("write", () => {
    it.effect("creates the file and its parents; a second write overwrites", () =>
      Effect.gen(function* () {
        const ws = yield* workspace()
        const first = yield* call(ws.cwd, "write", { path: "deep/er/new.txt", content: "héllo" })
        assert.deepStrictEqual(first.output, { path: ws.at("deep/er/new.txt"), bytes: 6, created: true })
        const second = yield* call(ws.cwd, "write", { path: "deep/er/new.txt", content: "x" })
        assert.deepStrictEqual(second.output, { path: ws.at("deep/er/new.txt"), bytes: 1, created: false })
        assert.strictEqual(yield* ws.fs.readFileString(ws.at("deep/er/new.txt")), "x")
      }),
    )

    it.effect("a directory cannot be written as a file", () =>
      Effect.gen(function* () {
        const ws = yield* workspace({ "dir/x": "" })
        const { output, isFailure } = yield* call(ws.cwd, "write", { path: "dir", content: "x" })
        assert.isTrue(isFailure)
        assert.strictEqual(yield* reasonOf(Write.failureSchema, output), "is-a-directory")
      }),
    )
  })

  describe("edit", () => {
    it.effect("replaces the one occurrence, taking `$` in the new text literally", () =>
      Effect.gen(function* () {
        const ws = yield* workspace({ "a.ts": "const a = 1\nconst b = 2\n" })
        const { output } = yield* call(ws.cwd, "edit", { path: "a.ts", oldString: "b = 2", newString: "b = `$1$&`" })
        assert.deepStrictEqual(output, { path: ws.at("a.ts"), replacements: 1 })
        assert.strictEqual(yield* ws.fs.readFileString(ws.at("a.ts")), "const a = 1\nconst b = `$1$&`\n")
      }),
    )

    it.effect("an ambiguous oldString is refused unless replaceAll, which counts", () =>
      Effect.gen(function* () {
        const ws = yield* workspace({ "a.txt": "x y x y x" })
        const refused = yield* call(ws.cwd, "edit", { path: "a.txt", oldString: "x", newString: "z" })
        assert.isTrue(refused.isFailure)
        assert.strictEqual(yield* reasonOf(Edit.failureSchema, refused.output), "old-string-not-unique")
        assert.strictEqual(yield* ws.fs.readFileString(ws.at("a.txt")), "x y x y x")
        const all = yield* call(ws.cwd, "edit", { path: "a.txt", oldString: "x", newString: "z", replaceAll: true })
        assert.deepStrictEqual(all.output, { path: ws.at("a.txt"), replacements: 3 })
        assert.strictEqual(yield* ws.fs.readFileString(ws.at("a.txt")), "z y z y z")
      }),
    )

    it.effect("text that is not there, and a file that is not there", () =>
      Effect.gen(function* () {
        const ws = yield* workspace({ "a.txt": "abc" })
        const absent = yield* call(ws.cwd, "edit", { path: "a.txt", oldString: "zzz", newString: "y" })
        assert.strictEqual(yield* reasonOf(Edit.failureSchema, absent.output), "old-string-not-found")
        const missing = yield* call(ws.cwd, "edit", { path: "nope.txt", oldString: "a", newString: "b" })
        assert.strictEqual(yield* reasonOf(Edit.failureSchema, missing.output), "not-found")
      }),
    )
  })

  describe("bash", () => {
    it.effect("runs in the working directory and returns the exit code with stdout and stderr together", () =>
      Effect.gen(function* () {
        const ws = yield* workspace()
        const { output, isFailure } = yield* call(ws.cwd, "bash", { command: "pwd; echo out; echo err 1>&2; exit 3" })
        assert.isFalse(isFailure)
        const result = yield* decoded(Bash.successSchema, output)
        assert.strictEqual(result.exitCode, 3)
        assert.include(result.output, `${ws.cwd}\n`)
        assert.include(result.output, "out\n")
        assert.include(result.output, "err\n")
        assert.isFalse(result.truncated)
        assert.isFalse(result.timedOut)
      }),
    )

    it.effect("a command past its timeout is killed; what it printed is kept", () =>
      Effect.gen(function* () {
        const ws = yield* workspace()
        const { output } = yield* call(ws.cwd, "bash", { command: "echo started; sleep 30; echo never", timeoutMs: 200 })
        assert.deepStrictEqual(output, { exitCode: BASH_TIMED_OUT_EXIT_CODE, output: "started\n", truncated: false, timedOut: true })
      }),
    )

    it.effect("output past the limit is dropped, and the command still runs to its end", () =>
      Effect.gen(function* () {
        const ws = yield* workspace()
        const { output } = yield* call(ws.cwd, "bash", { command: `yes | head -c ${BASH_OUTPUT_LIMIT * 2}; echo; echo tail` })
        const result = yield* decoded(Bash.successSchema, output)
        assert.strictEqual(result.exitCode, 0)
        assert.isTrue(result.truncated)
        assert.strictEqual(result.output.length, BASH_OUTPUT_LIMIT)
      }),
    )
  })
})
