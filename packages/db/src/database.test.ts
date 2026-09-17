import { assert, it } from "@effect/vitest"
import { BunFileSystem } from "@effect/platform-bun"
import { Context, Effect, FileSystem, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"

import { makeSqliteClientLayer, MigrationsLayer } from "./database"

it.live("two clients on one file share the schema; migrations run once", () =>
  Effect.gen(function* () {
    const fs = Context.get(yield* Layer.build(BunFileSystem.layer), FileSystem.FileSystem)
    const directory = yield* fs.makeTempDirectoryScoped()
    const client = () => Layer.provideMerge(MigrationsLayer, makeSqliteClientLayer(`${directory}/q.db`))

    const a = Context.get(yield* Layer.build(client()), SqlClient.SqlClient)
    const b = Context.get(yield* Layer.build(client()), SqlClient.SqlClient)
    yield* a`INSERT INTO session (id, cwd, created_at) VALUES (${"one"}, ${"/shared"}, ${0})`
    assert.deepStrictEqual(yield* b<{ id: string }>`SELECT id FROM session`, [{ id: "one" }])
    assert.deepStrictEqual(yield* b<{ n: number }>`SELECT COUNT(*) AS n FROM q_migrations`, [{ n: 1 }])
  }),
)
