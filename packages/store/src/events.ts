import {
  type AccountId,
  DaakError,
  ErrorCodes,
  type Event,
  type EventPayload,
  EventPayloadSchema,
  type Instant,
  nowInstant,
} from "@daak/contracts";
import { asNumber, asString, prepareLazily, type SqliteDriver } from "./driver.js";

/**
 * The append-only log.
 *
 * Nothing here updates or deletes a row, and there is deliberately no API to.
 * `seq` comes from SQLite's autoincrement, so it is monotonic across the whole
 * store and therefore monotonic per account, which is what the contract asks
 * for — and it cannot be assigned by a caller, which is what stops two writers
 * inventing the same one.
 */
export interface AppendEventInput {
  readonly accountId: AccountId;
  readonly source: Event["source"];
  readonly payload: EventPayload;
  /** Overridable for deterministic tests. Defaults to now. */
  readonly at?: Instant;
}

export interface EventLog {
  append(input: AppendEventInput): Event;
  appendMany(inputs: readonly AppendEventInput[]): Event[];
  since(accountId: AccountId, seq: number, limit?: number): Event[];
  all(accountId: AccountId): Event[];
  latestSeq(accountId: AccountId): number;
  count(accountId: AccountId): number;
}

const rowToEvent = (row: Record<string, unknown>): Event => {
  const payload = EventPayloadSchema.parse(JSON.parse(asString(row.payload)));
  return {
    seq: asNumber(row.seq),
    accountId: asString(row.account_id) as AccountId,
    at: asString(row.at) as Instant,
    source: asString(row.source) as Event["source"],
    payload,
  };
};

export const createEventLog = (driver: SqliteDriver): EventLog => {
  const insert = prepareLazily(
    driver,
    "insert into events (account_id, at, source, type, payload) values (?, ?, ?, ?, ?) returning seq",
  );
  const selectSince = prepareLazily(
    driver,
    "select seq, account_id, at, source, payload from events where account_id = ? and seq > ? order by seq limit ?",
  );
  const selectLatest = prepareLazily(
    driver,
    "select max(seq) as seq from events where account_id = ?",
  );
  const selectCount = prepareLazily(
    driver,
    "select count(*) as n from events where account_id = ?",
  );

  const appendOne = (input: AppendEventInput): Event => {
    // Validate before writing. An event that cannot be parsed back is an event
    // that breaks rebuild, and it breaks it silently, months later.
    const payload = EventPayloadSchema.parse(input.payload);
    const at = input.at ?? nowInstant();
    const row = insert.get(
      input.accountId,
      at,
      input.source,
      payload.type,
      JSON.stringify(payload),
    );
    const seq = row?.seq;
    if (seq === undefined) {
      throw DaakError.permanent(ErrorCodes.CONCURRENT_WRITE, "event insert returned no sequence");
    }
    return { seq: asNumber(seq), accountId: input.accountId, at, source: input.source, payload };
  };

  return {
    append: (input) => driver.transaction(() => appendOne(input)),

    appendMany: (inputs) =>
      // One transaction for the batch: a half-written set of events describes a
      // state the server was never in.
      driver.transaction(() => inputs.map(appendOne)),

    since: (accountId, seq, limit = 10_000) =>
      selectSince.all(accountId, seq, limit).map(rowToEvent),

    all(accountId) {
      const found: Event[] = [];
      let cursor = 0;
      for (;;) {
        const page = this.since(accountId, cursor, 5_000);
        if (page.length === 0) break;
        found.push(...page);
        const last = page[page.length - 1];
        if (last === undefined) break;
        cursor = last.seq;
      }
      return found;
    },

    latestSeq: (accountId) => asNumber(selectLatest.get(accountId)?.seq ?? 0),
    count: (accountId) => asNumber(selectCount.get(accountId)?.n ?? 0),
  };
};
