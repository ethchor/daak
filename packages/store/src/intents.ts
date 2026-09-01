import {
  type AccountId,
  type Instant,
  type Intent,
  type IntentId,
  type IntentOp,
  IntentOpSchema,
  type IntentState,
  type SerializedDaakError,
  type SyncCollection,
} from "@daak/contracts";
import {
  asNumber,
  asOptionalString,
  asString,
  prepareLazily,
  type SqliteDriver,
} from "./driver.js";

/**
 * The intent log, and the sync cursors beside it.
 *
 * Neither is a projection. An intent that has not reached a server yet exists
 * nowhere else in the world — losing this table loses the user's unsent
 * changes — and a cursor is the engine's place in a stream nobody else is
 * tracking.
 */
export interface IntentLog {
  record(intent: Intent): Intent;
  /**
   * Intents still owed to the provider, oldest first.
   *
   * `unknown` is included on purpose: an intent whose fate the provider never
   * reported is not finished, and the way to finish it is to send it again
   * under the same id. Leaving it out is how a mutation goes missing.
   */
  outstanding(accountId: AccountId, limit?: number): Intent[];
  get(id: IntentId): Intent | null;
  update(
    id: IntentId,
    patch: {
      state?: IntentState;
      attempts?: number;
      lastAttemptAt?: Instant;
      lastError?: SerializedDaakError | null;
    },
  ): void;
  countByState(accountId: AccountId): Record<string, number>;
  countOutstanding(accountId: AccountId): number;
}

const rowToIntent = (row: Record<string, unknown>): Intent => {
  const op = IntentOpSchema.parse(JSON.parse(asString(row.op))) as IntentOp;
  const lastError = asOptionalString(row.last_error);
  const lastAttemptAt = asOptionalString(row.last_attempt_at);
  return {
    id: asString(row.id) as IntentId,
    accountId: asString(row.account_id) as AccountId,
    createdAt: asString(row.created_at) as Instant,
    op,
    state: asString(row.state) as IntentState,
    attempts: asNumber(row.attempts),
    ...(lastAttemptAt === undefined ? {} : { lastAttemptAt: lastAttemptAt as Instant }),
    ...(lastError === undefined ? {} : { lastError: JSON.parse(lastError) as SerializedDaakError }),
  };
};

const OUTSTANDING_STATES = "('pending','inflight','unknown')";

export const createIntentLog = (driver: SqliteDriver): IntentLog => {
  const insert = prepareLazily(
    driver,
    `insert into intents (id, account_id, created_at, op, state, attempts, last_attempt_at, last_error)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectOne = prepareLazily(driver, "select * from intents where id = ?");
  const selectOutstanding = prepareLazily(
    driver,
    `select * from intents where account_id = ? and state in ${OUTSTANDING_STATES}
     order by created_at, id limit ?`,
  );
  const countOutstandingRow = prepareLazily(
    driver,
    `select count(*) as n from intents where account_id = ? and state in ${OUTSTANDING_STATES}`,
  );
  const countStates = prepareLazily(
    driver,
    "select state, count(*) as n from intents where account_id = ? group by state",
  );

  return {
    record(intent) {
      insert.run(
        intent.id,
        intent.accountId,
        intent.createdAt,
        JSON.stringify(intent.op),
        intent.state,
        intent.attempts,
        intent.lastAttemptAt ?? null,
        intent.lastError === undefined ? null : JSON.stringify(intent.lastError),
      );
      return intent;
    },

    outstanding: (accountId, limit = 200) =>
      selectOutstanding.all(accountId, limit).map(rowToIntent),

    get(id) {
      const row = selectOne.get(id);
      return row === undefined ? null : rowToIntent(row);
    },

    update(id, patch) {
      const sets: string[] = [];
      const params: (string | number | null)[] = [];
      if (patch.state !== undefined) {
        sets.push("state = ?");
        params.push(patch.state);
      }
      if (patch.attempts !== undefined) {
        sets.push("attempts = ?");
        params.push(patch.attempts);
      }
      if (patch.lastAttemptAt !== undefined) {
        sets.push("last_attempt_at = ?");
        params.push(patch.lastAttemptAt);
      }
      if (patch.lastError !== undefined) {
        sets.push("last_error = ?");
        params.push(patch.lastError === null ? null : JSON.stringify(patch.lastError));
      }
      if (sets.length === 0) return;
      params.push(id);
      driver
        .prepare(`update intents set ${sets.join(", ")} where id = ?`)
        .run(...(params as never[]));
    },

    countByState(accountId) {
      const counts: Record<string, number> = {};
      for (const row of countStates.all(accountId)) {
        counts[asString(row.state)] = asNumber(row.n);
      }
      return counts;
    },

    countOutstanding: (accountId) => asNumber(countOutstandingRow.get(accountId)?.n ?? 0),
  };
};

/** Where the engine has reached in each collection. */
export interface CursorStore {
  get(accountId: AccountId, collection: SyncCollection): string | null;
  getBackfill(
    accountId: AccountId,
    collection: SyncCollection,
  ): { lowWatermark: string | null; complete: boolean };
  setBackfill(
    accountId: AccountId,
    collection: SyncCollection,
    progress: { lowWatermark: string | null; complete: boolean; updatedAt: Instant },
  ): void;
}

export const createCursorStore = (driver: SqliteDriver): CursorStore => {
  const selectCursor = prepareLazily(
    driver,
    "select cursor from sync_cursors where account_id = ? and collection = ?",
  );
  const selectBackfill = prepareLazily(
    driver,
    "select low_watermark, complete from backfill_progress where account_id = ? and collection = ?",
  );
  const upsertBackfill = prepareLazily(
    driver,
    `insert into backfill_progress (account_id, collection, low_watermark, complete, updated_at)
     values (?, ?, ?, ?, ?)
     on conflict (account_id, collection) do update set
       low_watermark = excluded.low_watermark, complete = excluded.complete,
       updated_at = excluded.updated_at`,
  );

  return {
    get(accountId, collection) {
      const row = selectCursor.get(accountId, collection);
      const value = row?.cursor;
      return value === null || value === undefined || value === "" ? null : String(value);
    },

    getBackfill(accountId, collection) {
      const row = selectBackfill.get(accountId, collection);
      if (row === undefined) return { lowWatermark: null, complete: false };
      const watermark = asOptionalString(row.low_watermark);
      return {
        lowWatermark: watermark === undefined ? null : watermark,
        complete: asNumber(row.complete) === 1,
      };
    },

    setBackfill(accountId, collection, progress) {
      upsertBackfill.run(
        accountId,
        collection,
        progress.lowWatermark,
        progress.complete ? 1 : 0,
        progress.updatedAt,
      );
    },
  };
};
