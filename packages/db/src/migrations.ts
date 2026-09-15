import { Effect } from "effect"
import { Migrator, type SqlClient, type SqlError } from "effect/unstable/sql"

import { initialSchema } from "./migrations/0001-initial-schema"

const loader = Migrator.fromRecord({
  "0001_initial_schema": initialSchema,
})

/** Applies every migration that has not run yet, in order. Records them in `q_migrations`. */
export const runMigrations: Effect.Effect<
  ReadonlyArray<readonly [id: number, name: string]>,
  Migrator.MigrationError | SqlError.SqlError,
  SqlClient.SqlClient
> = Migrator.make({})({ loader, table: "q_migrations" })
