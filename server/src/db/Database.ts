import { Layer } from "effect"
import * as Migrations from "./Migrations.ts"
import * as Sql from "./Sql.ts"

/** A migrated database: provides `SqlClient` once all migrations have run. */
export const layer = Migrations.layer.pipe(Layer.provideMerge(Sql.layer))
