/**
 * The one thing `@daak/store` needs from SQLite.
 *
 * Deliberately tiny. The same schema and the same queries have to run on the
 * server and in a browser over OPFS, and the only way that stays true is if the
 * surface between the store and its engine is small enough to reimplement in an
 * afternoon.
 *
 * Synchronous on purpose: "single writer per account" is a sync-engine
 * invariant, not a limitation to work around, and a synchronous driver makes it
 * impossible to accidentally interleave two writers.
 */
export type SqlValue = string | number | bigint | Uint8Array | null;

export interface SqliteStatement {
  run(...params: SqlValue[]): { changes: number };
  get(...params: SqlValue[]): Record<string, SqlValue> | undefined;
  all(...params: SqlValue[]): Record<string, SqlValue>[];
}

export interface SqliteDriver {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  /**
   * Run `body` in a transaction, rolling back if it throws.
   *
   * Nesting uses savepoints, because a projector that opens a transaction
   * inside a rebuild that opened one must not silently commit the outer.
   */
  transaction<T>(body: () => T): T;
  close(): void;
}

/**
 * Prepare on first use, not on construction.
 *
 * A store has to be openable before its schema exists — `openStore()` then
 * `migrate()` is the normal order, and on a fresh database there is no `blobs`
 * table to prepare against yet. Preparing eagerly makes the store's constructor
 * depend on migration order, which is the kind of coupling that works until
 * someone opens a store on an empty file.
 */
export const prepareLazily = (driver: SqliteDriver, sql: string): SqliteStatement => {
  let statement: SqliteStatement | undefined;
  const resolve = (): SqliteStatement => {
    statement ??= driver.prepare(sql);
    return statement;
  };
  return {
    run: (...params) => resolve().run(...params),
    get: (...params) => resolve().get(...params),
    all: (...params) => resolve().all(...params),
  };
};

/**
 * SQLite has no boolean type, and `node:sqlite` refuses to bind one rather than
 * guessing. Convert at the boundary so no caller has to remember.
 */
export const toSqlBool = (value: boolean): number => (value ? 1 : 0);

/**
 * Column readers.
 *
 * They take `unknown` rather than `SqlValue` on purpose: a row is a bag of
 * columns, indexing it yields `SqlValue | undefined`, and threading that
 * through every call site would mean a cast at each one. Narrowing here means
 * exactly one place has to be right.
 */
export const fromSqlBool = (value: unknown): boolean => value === 1 || value === 1n;

export const asString = (value: unknown): string =>
  value === null || value === undefined ? "" : String(value);

export const asNumber = (value: unknown): number =>
  typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : 0;

export const asOptionalString = (value: unknown): string | undefined =>
  value === null || value === undefined ? undefined : String(value);
