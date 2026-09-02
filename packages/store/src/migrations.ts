import { DaakError, ErrorCodes } from "@daak/contracts";
import type { SqliteDriver } from "./driver.js";

/**
 * Migrations, numbered and reversible.
 *
 * Tracked with `pragma user_version` rather than a table, because the version
 * has to be readable before any table is known to exist.
 *
 * Every migration has a `down`. Where one is genuinely impossible, say so in a
 * comment rather than shipping a no-op that pretends the schema went backwards.
 *
 * The schema divides in two, and the division is the point (ARCHITECTURE.md
 * invariant 2):
 *
 *   sources of truth   blobs, events  — append-only, never rewritten
 *   projections        everything else — droppable, rebuildable from the above
 *
 * `accounts`, `intents` and `annotations` are neither: accounts are
 * configuration, intents are pending local state that has not reached a server
 * yet, and annotations are disposable by design. None of the three can be
 * derived from the log, and all three survive a rebuild.
 */
export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: string;
  readonly down: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial",
    up: `
      -- ============================ sources of truth ============================

      -- Content-addressed and immutable. Two accounts holding the same message
      -- share one row; nothing ever updates one.
      create table blobs (
        id          text primary key,
        size        integer not null,
        bytes       blob not null,
        created_at  text not null
      ) strict;

      -- Append-only. Carries no derived data: replay re-parses the blob, which
      -- is what makes "rebuildable from blobs + events" enforceable rather than
      -- aspirational.
      create table events (
        seq         integer primary key autoincrement,
        account_id  text not null,
        at          text not null,
        source      text not null check (source in ('remote','local','rebuild')),
        type        text not null,
        payload     text not null
      ) strict;
      create index events_by_account on events (account_id, seq);

      -- ============================ configuration ==============================

      -- Credentials are NOT here. secret_ref names an entry in the OS keychain;
      -- a stolen database file must not be a stolen mailbox.
      create table accounts (
        id            text primary key,
        provider_kind text not null,
        name          text not null,
        identities    text not null,
        endpoint      text,
        secret_ref    text,
        created_at    text not null,
        disabled_at   text
      ) strict;

      -- ============================== projections ==============================

      create table mailboxes (
        id              text primary key,
        account_id      text not null,
        provider_id     text not null,
        name            text not null,
        parent_id       text,
        role            text not null,
        sort_order      integer not null default 0,
        reported_total  integer,
        reported_unread integer,
        unique (account_id, provider_id)
      ) strict;

      create table messages (
        id                text primary key,
        account_id        text not null,
        blob_id           text not null references blobs (id),
        thread_id         text not null,
        provider_id       text not null,
        received_at       text not null,
        sent_at           text,
        subject           text not null,
        addr_from         text not null,
        addr_to           text not null,
        addr_cc           text not null,
        addr_bcc          text not null,
        addr_reply_to     text not null,
        message_id_header text not null,
        in_reply_to       text not null,
        refs              text not null,
        list_id           text,
        size              integer not null,
        has_attachment    integer not null,
        preview           text not null,
        unique (account_id, provider_id)
      ) strict;
      create index messages_by_received on messages (account_id, received_at desc);
      create index messages_by_thread on messages (thread_id, received_at);
      create index messages_by_blob on messages (blob_id);

      -- Keywords and mailbox membership are sets, and they are queried as sets:
      -- unread counts, mailbox listings, "is this flagged". A JSON column would
      -- make every one of those a table scan.
      create table message_keywords (
        message_id text not null references messages (id) on delete cascade,
        keyword    text not null,
        primary key (message_id, keyword)
      ) strict;
      create index message_keywords_by_keyword on message_keywords (keyword, message_id);

      create table message_mailboxes (
        message_id text not null references messages (id) on delete cascade,
        mailbox_id text not null,
        primary key (message_id, mailbox_id)
      ) strict;
      create index message_mailboxes_by_mailbox on message_mailboxes (mailbox_id, message_id);

      create table threads (
        id              text primary key,
        account_id      text not null,
        subject         text not null,
        participants    text not null,
        last_message_at text not null,
        message_count   integer not null
      ) strict;
      create index threads_by_activity on threads (account_id, last_message_at desc);

      -- ========================= local mutation state ==========================

      -- Not a projection: an intent that has not reached a server yet exists
      -- nowhere else. Losing this table loses the user's unsent changes.
      create table intents (
        id              text primary key,
        account_id      text not null,
        created_at      text not null,
        op              text not null,
        state           text not null,
        attempts        integer not null default 0,
        last_attempt_at text,
        last_error      text
      ) strict;
      create index intents_by_state on intents (account_id, state, created_at);

      -- ============================= annotations ===============================

      -- Versioned and disposable. Dropping every row must cost nothing but
      -- recomputation.
      create table annotations (
        id               text primary key,
        account_id       text not null,
        subject_kind     text not null check (subject_kind in ('message','thread')),
        subject_id       text not null,
        namespace        text not null,
        key              text not null,
        value            text not null,
        producer         text not null,
        producer_version integer not null,
        input_hash       text,
        confidence       real,
        created_at       text not null,
        expires_at       text,
        unique (subject_kind, subject_id, namespace, key, producer)
      ) strict;
      create index annotations_by_subject on annotations (subject_kind, subject_id);

      -- ============================== sync state ===============================

      create table sync_cursors (
        account_id text not null,
        collection text not null,
        cursor     text,
        updated_at text not null,
        primary key (account_id, collection)
      ) strict;

      create table backfill_progress (
        account_id     text not null,
        collection     text not null,
        low_watermark  text,
        complete       integer not null default 0,
        updated_at     text not null,
        primary key (account_id, collection)
      ) strict;
    `,
    down: `
      drop table if exists backfill_progress;
      drop table if exists sync_cursors;
      drop table if exists annotations;
      drop table if exists intents;
      drop table if exists threads;
      drop table if exists message_mailboxes;
      drop table if exists message_keywords;
      drop table if exists messages;
      drop table if exists mailboxes;
      drop table if exists accounts;
      drop table if exists events;
      drop table if exists blobs;
    `,
  },
  {
    version: 2,
    name: "search-index",
    up: `
      -- The full-text index. A projection like any other: droppable, and
      -- rebuildable from the blobs.
      --
      -- The schema lives here because the store owns every table — migrations
      -- stay in one ordered, reversible place — while @daak/search owns what
      -- goes into it and how it is queried. A store rebuild empties this table;
      -- repopulating it is the search package's job, not a migration's.
      --
      -- account_id is carried so a rebuild can be scoped to one account.
      -- Both ids are UNINDEXED: they are for filtering and joining, and
      -- tokenising an opaque id only pollutes the term dictionary.
      create virtual table message_fts using fts5 (
        message_id UNINDEXED,
        account_id UNINDEXED,
        subject,
        sender,
        recipients,
        body,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `,
    down: `
      drop table if exists message_fts;
    `,
  },
];

export const LATEST_VERSION = MIGRATIONS.reduce(
  (highest, migration) => Math.max(highest, migration.version),
  0,
);

const readVersion = (driver: SqliteDriver): number => {
  const row = driver.prepare("pragma user_version").get();
  const value = row?.user_version;
  return typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : 0;
};

/** `pragma user_version` will not take a bound parameter, so the number is inlined. */
const writeVersion = (driver: SqliteDriver, version: number): void => {
  if (!Number.isInteger(version) || version < 0) {
    throw DaakError.permanent(ErrorCodes.INVALID_INPUT, `bad schema version ${version}`);
  }
  driver.exec(`pragma user_version = ${version}`);
};

export const currentVersion = readVersion;

/** Apply every migration above the current version, in order, transactionally. */
export const migrate = (driver: SqliteDriver, target = LATEST_VERSION): number => {
  const from = readVersion(driver);
  if (from > LATEST_VERSION) {
    // A database written by a newer Daak. Refusing is the only safe answer —
    // running old code against a newer schema corrupts quietly.
    throw DaakError.permanent(
      ErrorCodes.UNSUPPORTED,
      `database is at schema ${from}, this build understands ${LATEST_VERSION}`,
      { context: { databaseVersion: from, supportedVersion: LATEST_VERSION } },
    );
  }

  const pending = MIGRATIONS.filter((m) => m.version > from && m.version <= target).sort(
    (a, b) => a.version - b.version,
  );

  for (const migration of pending) {
    driver.transaction(() => {
      driver.exec(migration.up);
      writeVersion(driver, migration.version);
    });
  }
  return readVersion(driver);
};

/** Walk back down to `target`. Exists so migrations are proven reversible in CI. */
export const rollback = (driver: SqliteDriver, target: number): number => {
  const from = readVersion(driver);
  const pending = MIGRATIONS.filter((m) => m.version <= from && m.version > target).sort(
    (a, b) => b.version - a.version,
  );

  for (const migration of pending) {
    driver.transaction(() => {
      driver.exec(migration.down);
      writeVersion(driver, migration.version - 1);
    });
  }
  return readVersion(driver);
};
