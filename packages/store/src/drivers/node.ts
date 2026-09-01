import { DatabaseSync } from "node:sqlite";
import { DaakError, ErrorCodes } from "@daak/contracts";
import type { SqliteDriver, SqliteStatement, SqlValue } from "../driver.js";

/**
 * The Node driver, on `node:sqlite`.
 *
 * Built into Node 22, which is already the floor (D-14), so this costs no
 * dependency and no native build step — contributors run `pnpm install` and
 * everything works, and CI needs no toolchain. SQLite 3.51 with FTS5,
 * recursive CTEs and JSON1, which is the whole feature list the store needs.
 *
 * `node:sqlite` is still marked experimental in Node 22 (stable in 24). The
 * surface used here is small and the driver interface exists precisely so this
 * can be swapped for `better-sqlite3` without touching a query.
 */
export interface NodeDriverOptions {
  /** `:memory:` for tests, a file path otherwise. */
  readonly location?: string;
}

export const createNodeDriver = (options: NodeDriverOptions = {}): SqliteDriver => {
  const db = new DatabaseSync(options.location ?? ":memory:");

  // WAL keeps readers from blocking the single writer. `foreign_keys` is off by
  // default in SQLite and the schema leans on cascades, so it has to be asked
  // for explicitly on every connection.
  db.exec("pragma journal_mode = wal");
  db.exec("pragma foreign_keys = on");
  db.exec("pragma synchronous = normal");

  let depth = 0;

  return {
    exec(sql) {
      db.exec(sql);
    },

    prepare(sql): SqliteStatement {
      const statement = db.prepare(sql);
      return {
        run: (...params) => {
          const result = statement.run(...(params as never[]));
          return { changes: Number(result.changes) };
        },
        get: (...params) =>
          statement.get(...(params as never[])) as Record<string, SqlValue> | undefined,
        all: (...params) => statement.all(...(params as never[])) as Record<string, SqlValue>[],
      };
    },

    transaction<T>(body: () => T): T {
      // Savepoints for nesting: a projector that opens a transaction inside a
      // rebuild must not commit the outer one when it finishes.
      const name = `daak_sp_${depth}`;
      db.exec(depth === 0 ? "begin immediate" : `savepoint ${name}`);
      depth += 1;
      try {
        const result = body();
        depth -= 1;
        db.exec(depth === 0 ? "commit" : `release ${name}`);
        return result;
      } catch (error) {
        depth -= 1;
        try {
          db.exec(depth === 0 ? "rollback" : `rollback to ${name}`);
        } catch {
          // A rollback that itself fails means the connection is unusable.
          // Surfacing the original error is more useful than this one.
        }
        throw error;
      }
    },

    close() {
      db.close();
    },
  };
};

/** Wrap a driver failure in the taxonomy rather than letting a raw error escape. */
export const asStoreError = (error: unknown, operation: string): DaakError => {
  const message = error instanceof Error ? error.message : String(error);
  const busy = message.includes("SQLITE_BUSY") || message.includes("database is locked");
  return busy
    ? DaakError.transient(ErrorCodes.BUSY, `store busy during ${operation}`)
    : DaakError.permanent(ErrorCodes.CONCURRENT_WRITE, `${operation} failed: ${message}`, {
        cause: error,
      });
};
