import { type Array, Context, Effect, Layer, Schema } from "effect"
import { Prompt } from "effect/ai"
import { SqlClient, type SqlError, SqlSchema } from "effect/sql"
import { SessionId } from "../domain/Session.ts"
import { TurnId } from "../domain/Turn.ts"

const MessageJson = Schema.toCodecJson(Prompt.Message)

/**
 * Persistence for model logs: per session, the prompt messages the model has
 * been given and has produced, in order. This is the agent's record of the
 * conversation (prompts are built from it); clients read the session stream.
 *
 * - `append` is one statement that numbers the new messages from the log's end.
 * - Rows that fail to decode are corrupt data or a bug, so they are defects.
 */
export interface ModelLogShape {
  readonly append: (
    sessionId: SessionId,
    turnId: TurnId,
    messages: Array.NonEmptyReadonlyArray<Prompt.Message>
  ) => Effect.Effect<void, SqlError.SqlError>
  /** The whole conversation, as a prompt. */
  readonly history: (sessionId: SessionId) => Effect.Effect<Prompt.Prompt, SqlError.SqlError>
}

export class ModelLog extends Context.Service<ModelLog, ModelLogShape>()("@q/server/services/ModelLog", {
  make: Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient

    const append = SqlSchema.void({
      Request: Schema.Struct({
        sessionId: SessionId,
        turnId: TurnId,
        messages: Schema.fromJsonString(Schema.Array(MessageJson))
      }),
      execute: ({ messages, sessionId, turnId }) =>
        sql`
          INSERT INTO model_messages (session_id, seq, turn_id, message)
          SELECT ${sessionId}, log_end.next + incoming.key, ${turnId}, incoming.value
          FROM (SELECT COALESCE(MAX(seq) + 1, 0) AS next FROM model_messages WHERE session_id = ${sessionId}) AS log_end,
               json_each(${messages}) AS incoming
          ORDER BY incoming.key
        `
    })

    const history = SqlSchema.findAll({
      Request: SessionId,
      Result: Schema.Struct({ message: Schema.fromJsonString(MessageJson) }),
      execute: (sessionId) => sql`SELECT message FROM model_messages WHERE session_id = ${sessionId} ORDER BY seq`
    })

    return {
      append: Effect.fn("ModelLog.append")((sessionId, turnId, messages) =>
        append({ sessionId, turnId, messages }).pipe(Effect.catchTag("SchemaError", Effect.die))
      ),
      history: Effect.fn("ModelLog.history")((sessionId) =>
        history(sessionId).pipe(
          Effect.map((rows) => Prompt.fromMessages(rows.map((row) => row.message))),
          Effect.catchTag("SchemaError", Effect.die)
        )
      )
    } satisfies ModelLogShape
  })
}) {
  static readonly layer = Layer.effect(ModelLog, ModelLog.make)
}
