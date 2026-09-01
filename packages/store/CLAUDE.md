# @daak/store — Lane C, week 1

SQLite schema, migrations, typed queries. Same package on the server and in the
browser; only the driver differs.

## Done when

Migrations run forward and back cleanly, and a property test shows that
replaying a store's events rebuilds every derived table byte-identically.

## Architecture

Two tables are sources of truth: `blobs` and `events`. Everything else —
`messages`, `threads`, `mailboxes`, search indexes — is a projection and must be
droppable and rebuildable. That is what makes a schema change a rebuild rather
than a migration, and it is the invariant most likely to be quietly broken by
someone adding "just one" mutable column.

Drivers behind one interface: `better-sqlite3` on Node, `@sqlite.org/sqlite-wasm`
over OPFS in the browser. FTS5 is required in both.

## Allowed imports

`@daak/contracts`, a SQLite driver, `zod`.

## Forbidden

- An ORM. The queries that matter here — recursive CTEs for threads, FTS5 with
  ranking, partial indexes — are exactly the ones an ORM obscures. Write SQL.
- Writes to a projection table from outside a projector.
- Migrations that are not reversible, unless the down step is genuinely
  impossible, in which case say so in a comment.
- Storing credentials. Ever. They live in the OS keychain; the store holds a
  reference.

## Test

    pnpm --filter @daak/store test
