import { Schema } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"

// AGENT TOOLS — the contract of every tool the agent may call: name, parameters, result. Handlers live in core.
// Everything typed by the toolkit (UI parts, chunks, transcript events) derives from this one value.
//
// The four tools pi ships with. Every failure is `failureMode: "return"`: a missing file or a bad edit is an
// answer for the model to act on, not a crash of the turn. A non-zero exit code is a `bash` success value.

const Path = Schema.String.annotate({
  description: "A file path. Relative paths resolve against the working directory.",
})

/** Why a tool could not do its job, for the model. `reason` is stable; `message` is the detail. */
const failure = <const Reasons extends ReadonlyArray<string>>(reasons: Reasons) =>
  Schema.Struct({ reason: Schema.Literals(reasons), message: Schema.String })

export const Read = Tool.make("read", {
  description:
    "Read a text file. Returns its content with one line per line, or a window of lines when offset/limit are given. Large files are truncated; read a window to see the rest.",
  parameters: Schema.Struct({
    path: Path,
    offset: Schema.optionalKey(Schema.Int.annotate({ description: "The 1-based line to start at. Default: 1." })),
    limit: Schema.optionalKey(Schema.Int.annotate({ description: "How many lines to return. Default: all, up to the cap." })),
  }),
  success: Schema.Struct({
    path: Schema.String,
    content: Schema.String,
    /** Lines in the whole file, so the model knows how much it did not see. */
    totalLines: Schema.Int,
    truncated: Schema.Boolean,
  }),
  failure: failure(["not-found", "not-a-file", "io"]),
  failureMode: "return",
}).annotate(Tool.Readonly, true)

export const Write = Tool.make("write", {
  description: "Create or overwrite a file with the given content. Missing parent directories are created.",
  parameters: Schema.Struct({
    path: Path,
    content: Schema.String.annotate({ description: "The whole new content of the file." }),
  }),
  success: Schema.Struct({ path: Schema.String, bytes: Schema.Int, created: Schema.Boolean }),
  failure: failure(["is-a-directory", "io"]),
  failureMode: "return",
}).annotate(Tool.Destructive, true)

export const Edit = Tool.make("edit", {
  description:
    "Replace an exact string in a file. oldString must occur exactly once unless replaceAll is true. Include enough surrounding lines to make it unique.",
  parameters: Schema.Struct({
    path: Path,
    oldString: Schema.String.annotate({ description: "The exact text to replace, including whitespace." }),
    newString: Schema.String.annotate({ description: "The text to put in its place." }),
    replaceAll: Schema.optionalKey(Schema.Boolean.annotate({ description: "Replace every occurrence. Default: false." })),
  }),
  success: Schema.Struct({ path: Schema.String, replacements: Schema.Int }),
  failure: failure(["not-found", "not-a-file", "old-string-not-found", "old-string-not-unique", "io"]),
  failureMode: "return",
}).annotate(Tool.Destructive, true)

export const Bash = Tool.make("bash", {
  description:
    "Run a shell command with bash in the working directory. Returns the exit code and the combined stdout and stderr. Long output is truncated; a command that runs past the timeout is killed.",
  parameters: Schema.Struct({
    command: Schema.String.annotate({ description: "The command line, as you would type it in bash." }),
    timeoutMs: Schema.optionalKey(
      Schema.Int.annotate({ description: "Kill the command after this many milliseconds. Default: 2 minutes." }),
    ),
  }),
  success: Schema.Struct({
    exitCode: Schema.Int,
    /** stdout and stderr interleaved, in the order they arrived. */
    output: Schema.String,
    truncated: Schema.Boolean,
    timedOut: Schema.Boolean,
  }),
  failure: failure(["spawn-failed", "killed", "io"]),
  failureMode: "return",
}).annotate(Tool.Destructive, true)

export const AgentToolkit = Toolkit.make(Read, Write, Edit, Bash)
export type AgentTools = typeof AgentToolkit.tools
