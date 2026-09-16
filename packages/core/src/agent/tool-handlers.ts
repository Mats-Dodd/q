import { AgentToolkit, type Bash, type Edit, type Read, type Write } from "@q/domain/agent/tools"
import { Duration, Effect, FileSystem, Path, type PlatformError, Ref, Stream } from "effect"
import type { Tool } from "effect/unstable/ai"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

// TOOL HANDLERS — what each tool does when the model calls it, over the platform services. Every handler
// resolves paths against the session's working directory and answers a failure the model can act on.

/** A `read` stops after this many lines, whatever the file holds. */
export const READ_MAX_LINES = 2000
/** A `read` stops once the window would exceed this many characters. */
const READ_MAX_CHARS = 64 * 1024
/** How long `bash` waits for a command that names no timeout. */
const BASH_TIMEOUT = Duration.minutes(2)
/** `bash` keeps this many characters of output; the rest is read and dropped so the child never blocks. */
export const BASH_OUTPUT_LIMIT = 1024 * 1024
/** After the scope closes a `bash` child gets `SIGTERM`, then `SIGKILL` this much later if it is still there. */
const BASH_FORCE_KILL_AFTER = Duration.seconds(5)
/** The exit code reported for a command the timeout killed. */
export const BASH_TIMED_OUT_EXIT_CODE = -1

type ReadFailure = Tool.Failure<typeof Read>
type WriteFailure = Tool.Failure<typeof Write>
type EditFailure = Tool.Failure<typeof Edit>
type BashFailure = Tool.Failure<typeof Bash>

/** What went wrong at the OS level, as a tool failure. `notFound`/`badResource` name the cases a tool tells apart. */
const platformFailure =
  <Reason extends string>(map: { readonly notFound?: Reason; readonly badResource?: Reason; readonly io: Reason }) =>
  (error: PlatformError.PlatformError): { readonly reason: Reason; readonly message: string } => {
    const tag = error.reason._tag
    const reason =
      tag === "NotFound" && map.notFound !== undefined
        ? map.notFound
        : tag === "BadResource" && map.badResource !== undefined
          ? map.badResource
          : map.io
    return { reason, message: error.message }
  }

/** The lines of `text`, without a trailing empty line for a file that ends in a newline. */
const linesOf = (text: string): ReadonlyArray<string> => {
  if (text.length === 0) return []
  const lines = text.split(/\r?\n/)
  if (lines.at(-1) === "") lines.pop()
  return lines
}

/** At most `READ_MAX_LINES` lines and `READ_MAX_CHARS` characters of `lines`, and whether that left anything out. */
const cap = (lines: ReadonlyArray<string>): { readonly kept: ReadonlyArray<string>; readonly truncated: boolean } => {
  const kept: Array<string> = []
  let chars = 0
  for (const line of lines) {
    if (kept.length >= READ_MAX_LINES || chars + line.length + 1 > READ_MAX_CHARS) return { kept, truncated: true }
    kept.push(line)
    chars += line.length + 1
  }
  return { kept, truncated: false }
}

/** How many times `needle` occurs in `text`. An empty needle occurs nowhere. */
const occurrences = (text: string, needle: string): number => (needle.length === 0 ? 0 : text.split(needle).length - 1)

/**
 * The handlers of every agent tool, bound to `cwd`. Yields the platform services once, when built;
 * the handlers close over them. Nothing runs until the model calls a tool.
 */
export const toolHandlers = (cwd: string) =>
  AgentToolkit.toHandlers(
    Effect.gen(function* toolHandlers() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const resolve = (p: string) => path.resolve(cwd, p)

      const readFailure = platformFailure<ReadFailure["reason"]>({ notFound: "not-found", badResource: "not-a-file", io: "io" })
      const writeFailure = platformFailure<WriteFailure["reason"]>({ badResource: "is-a-directory", io: "io" })
      const editFailure = platformFailure<EditFailure["reason"]>({ notFound: "not-found", badResource: "not-a-file", io: "io" })

      return AgentToolkit.of({
        read: Effect.fn("tool.read")(function* ({ path: p, offset, limit }) {
          const abs = resolve(p)
          const text = yield* Effect.mapError(fs.readFileString(abs), readFailure)
          const lines = linesOf(text)
          const start = Math.max(offset ?? 1, 1) - 1
          const window = lines.slice(start, limit === undefined ? undefined : start + Math.max(limit, 0))
          const { kept, truncated } = cap(window)
          return { path: abs, content: kept.map((line) => `${line}\n`).join(""), totalLines: lines.length, truncated }
        }),

        write: Effect.fn("tool.write")(function* ({ path: p, content }) {
          const abs = resolve(p)
          const existed = yield* fs.exists(abs)
          yield* fs.makeDirectory(path.dirname(abs), { recursive: true })
          yield* fs.writeFileString(abs, content)
          return { path: abs, bytes: new TextEncoder().encode(content).byteLength, created: !existed }
        }, Effect.mapError(writeFailure)),

        edit: Effect.fn("tool.edit")(function* ({ path: p, oldString, newString, replaceAll }) {
          const abs = resolve(p)
          const text = yield* Effect.mapError(fs.readFileString(abs), editFailure)
          const count = occurrences(text, oldString)
          if (count === 0) {
            return yield* Effect.fail<EditFailure>({ reason: "old-string-not-found", message: `oldString does not occur in ${abs}` })
          }
          if (count > 1 && replaceAll !== true) {
            return yield* Effect.fail<EditFailure>({
              reason: "old-string-not-unique",
              message: `oldString occurs ${count} times in ${abs}; add context to make it unique, or set replaceAll`,
            })
          }
          // A function replacement: `$` in `newString` is text, not a pattern reference.
          const next = replaceAll === true ? text.replaceAll(oldString, () => newString) : text.replace(oldString, () => newString)
          yield* Effect.mapError(fs.writeFileString(abs, next), editFailure)
          return { path: abs, replacements: replaceAll === true ? count : 1 }
        }),

        bash: Effect.fn("tool.bash")(function* ({ command, timeoutMs }) {
          const timeout = timeoutMs === undefined ? BASH_TIMEOUT : Duration.millis(timeoutMs)
          // The output so far lives outside the timed region, so a killed command still reports what it printed.
          const collected = yield* Ref.make({ output: "", truncated: false })
          const keep = (chunk: string) =>
            Ref.update(collected, ({ output, truncated }) => {
              const room = BASH_OUTPUT_LIMIT - output.length
              return room >= chunk.length
                ? { output: output + chunk, truncated }
                : { output: output + chunk.slice(0, room), truncated: true }
            })
          const run = Effect.gen(function* () {
            const handle = yield* Effect.mapError(
              spawner.spawn(
                ChildProcess.make("bash", ["-c", command], {
                  cwd,
                  extendEnv: true,
                  stdin: "ignore",
                  forceKillAfter: BASH_FORCE_KILL_AFTER,
                }),
              ),
              (error): BashFailure => ({ reason: "spawn-failed", message: error.message }),
            )
            // Read everything the child writes, even past the limit: an unread pipe would block it.
            yield* handle.all.pipe(
              Stream.decodeText(),
              Stream.runForEach(keep),
              Effect.mapError((error): BashFailure => ({ reason: "io", message: error.message })),
            )
            return yield* Effect.mapError(handle.exitCode, (error): BashFailure => ({ reason: "killed", message: error.message }))
          }).pipe(Effect.scoped)
          const exit = yield* Effect.timeoutOption(run, timeout)
          const { output, truncated } = yield* Ref.get(collected)
          return exit._tag === "None"
            ? { exitCode: BASH_TIMED_OUT_EXIT_CODE, output, truncated, timedOut: true }
            : { exitCode: exit.value, output, truncated, timedOut: false }
        }),
      })
    }),
  )
