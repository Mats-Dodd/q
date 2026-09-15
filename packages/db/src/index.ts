// @q/db — the implementation of `TranscriptRepository`. The tag itself is in @q/core; this package
// is the adapter side. `Sql` over any `SqlClient`, `Sqlite` to bind one to a file, `Storage` for both
// at once. Tests run `Sql` on a `:memory:` SQLite: the real thing, with nothing on disk.
export { Sql } from "./sql"
export { DbPath, Sqlite, Storage } from "./sqlite"
