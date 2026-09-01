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

Drivers behind one interface: `node:sqlite` on Node (built in, no native build,
SQLite 3.51 with FTS5), `@sqlite.org/sqlite-wasm` over OPFS in the browser. FTS5
is required in both. `node:sqlite` prints an experimental warning on every run;
that is expected and documented in `docs/TECH_STACK.md` D-06.

## Two things this package got wrong once, so you do not have to

**Prepare statements lazily.** A store has to be openable before its schema
exists — `openStore()` then `migrate()` is the normal order, and on a fresh
database there is no table to prepare against yet.

**Replay must be total.** A property test found this on its first run: a
`keywords.set` event arriving after `message.removed` threw a foreign-key error,
which would have made that account permanently unrebuildable — discovered only
the first time someone needed a rebuild. A set operation on a message that is
not here is a no-op, not an error.

## Allowed imports

`@daak/contracts` and a SQLite driver. Nothing else.

Deriving a message's subject means parsing bytes, and threading means running
JWZ — but this package must not import `@daak/mime` or `@daak/threading`. Those
are injected as `Projectors`, which is what keeps the store testable without a
parser and the parser testable without a database. `@daak/sync` does the wiring
in production; the test harness does it in tests.

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
