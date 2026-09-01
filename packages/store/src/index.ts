/**
 * @daak/store — SQLite schema, migrations, and typed queries.
 *
 * Two tables are sources of truth: `blobs` and `events`. Everything else is a
 * projection, and `rebuild()` proves it — drop every derived row, replay the
 * log, and the result must be identical. That is what makes a schema change to
 * a derived table a rebuild rather than a migration.
 */

export { createBlobStore, digestBlob, verifyBlob } from "./blobs.js";
export type { SqliteDriver, SqliteStatement, SqlValue } from "./driver.js";
export type { NodeDriverOptions } from "./drivers/node.js";
export { createNodeDriver } from "./drivers/node.js";
export type { AppendEventInput, EventLog } from "./events.js";
export { createEventLog } from "./events.js";
export type { Migration } from "./migrations.js";
export { currentVersion, LATEST_VERSION, MIGRATIONS, migrate, rollback } from "./migrations.js";
export type { MessageFields, Projector, Projectors, ThreadInput } from "./projections.js";
export { createProjector } from "./projections.js";
export type { MessageQuery, ProjectionSnapshot, Store, StoreOptions } from "./store.js";
export { openStore } from "./store.js";
