import type {
  AccountId,
  BlobId,
  BlobStore,
  EmailAddress,
  Instant,
  Mailbox,
  MailboxId,
  Message,
  MessageId,
  Thread,
  ThreadId,
} from "@daak/contracts";
import { createBlobStore } from "./blobs.js";
import {
  asNumber,
  asOptionalString,
  asString,
  fromSqlBool,
  prepareLazily,
  type SqliteDriver,
} from "./driver.js";
import { createEventLog, type EventLog } from "./events.js";
import { currentVersion, LATEST_VERSION, migrate, rollback } from "./migrations.js";
import { createProjector, type Projector, type Projectors } from "./projections.js";

export interface StoreOptions {
  readonly driver: SqliteDriver;
  readonly projectors: Projectors;
}

/**
 * Optional fields accept `undefined` explicitly.
 *
 * A query is assembled from optional sources — a selected mailbox, a filter
 * that may be off, the cursor from a previous page that may not exist. Under
 * `exactOptionalPropertyTypes` a plain `?` would force every caller into a
 * conditional spread for no gain.
 */
export interface MessageQuery {
  readonly accountId: AccountId;
  readonly mailboxId?: MailboxId | undefined;
  readonly threadId?: ThreadId | undefined;
  readonly hasKeyword?: string | undefined;
  readonly lacksKeyword?: string | undefined;
  readonly limit?: number | undefined;
  /** `receivedAt` of the last row from the previous page. */
  readonly before?: Instant | undefined;
}

/**
 * A deterministic dump of everything derived.
 *
 * This is what makes ARCHITECTURE.md invariant 2 a test rather than a claim:
 * take a snapshot, drop every projection, replay the log, take another, and
 * compare. Sorted throughout, because a snapshot whose order depends on SQLite's
 * query plan compares unequal for reasons that have nothing to do with the
 * invariant.
 */
export interface ProjectionSnapshot {
  readonly messages: readonly string[];
  readonly threads: readonly string[];
  readonly mailboxes: readonly string[];
  readonly cursors: readonly string[];
}

export interface Store {
  readonly blobs: BlobStore;
  readonly events: EventLog;
  readonly projector: Projector;
  readonly driver: SqliteDriver;

  migrate(target?: number): number;
  rollback(target: number): number;
  schemaVersion(): number;

  /**
   * Drop every projection for an account and replay the log.
   *
   * Routine, not disaster recovery: it is how a schema change to a derived
   * table ships, and how a parser improvement reaches messages already stored.
   */
  rebuild(accountId: AccountId): Promise<void>;

  getMessage(id: MessageId): Message | null;
  queryMessages(query: MessageQuery): Message[];
  getThread(id: ThreadId): Thread | null;
  listMailboxes(accountId: AccountId): Mailbox[];
  countMessages(accountId: AccountId): number;

  snapshot(accountId: AccountId): ProjectionSnapshot;
  close(): void;
}

const parseJson = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== "string" || value === "") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

export const openStore = ({ driver, projectors }: StoreOptions): Store => {
  const blobs = createBlobStore(driver);
  const events = createEventLog(driver);
  const projector = createProjector(driver, projectors);

  const MESSAGE_COLUMNS = `
    m.id, m.account_id, m.blob_id, m.thread_id, m.provider_id, m.received_at, m.sent_at,
    m.subject, m.addr_from, m.addr_to, m.addr_cc, m.addr_bcc, m.addr_reply_to,
    m.message_id_header, m.in_reply_to, m.refs, m.list_id, m.size, m.has_attachment, m.preview
  `;

  const selectMessage = prepareLazily(
    driver,
    `select ${MESSAGE_COLUMNS} from messages m where m.id = ?`,
  );
  const selectKeywords = prepareLazily(
    driver,
    "select keyword from message_keywords where message_id = ? order by keyword",
  );
  const selectMailboxIds = prepareLazily(
    driver,
    "select mailbox_id from message_mailboxes where message_id = ? order by mailbox_id",
  );
  const selectThread = prepareLazily(driver, "select * from threads where id = ?");
  const selectThreadMessages = prepareLazily(
    driver,
    "select id from messages where thread_id = ? order by received_at, id",
  );
  const selectMailboxes = prepareLazily(
    driver,
    "select * from mailboxes where account_id = ? order by sort_order, name",
  );
  const countRows = prepareLazily(
    driver,
    "select count(*) as n from messages where account_id = ?",
  );

  const hydrate = (row: Record<string, unknown>): Message => {
    const id = asString(row.id) as MessageId;
    return {
      id,
      accountId: asString(row.account_id) as AccountId,
      blobId: asString(row.blob_id) as BlobId,
      threadId: asString(row.thread_id) as ThreadId,
      providerId: asString(row.provider_id),
      mailboxIds: selectMailboxIds.all(id).map((r) => asString(r.mailbox_id) as MailboxId),
      keywords: selectKeywords.all(id).map((r) => asString(r.keyword)),
      receivedAt: asString(row.received_at) as Instant,
      ...(row.sent_at === null ? {} : { sentAt: asString(row.sent_at) as Instant }),
      from: parseJson<EmailAddress[]>(row.addr_from, []),
      to: parseJson<EmailAddress[]>(row.addr_to, []),
      cc: parseJson<EmailAddress[]>(row.addr_cc, []),
      bcc: parseJson<EmailAddress[]>(row.addr_bcc, []),
      replyTo: parseJson<EmailAddress[]>(row.addr_reply_to, []),
      subject: asString(row.subject),
      messageIdHeader: parseJson<string[]>(row.message_id_header, []),
      inReplyTo: parseJson<string[]>(row.in_reply_to, []),
      references: parseJson<string[]>(row.refs, []),
      ...(row.list_id === null ? {} : { listId: asString(row.list_id) }),
      size: asNumber(row.size),
      hasAttachment: fromSqlBool(row.has_attachment),
      preview: asString(row.preview),
    };
  };

  return {
    blobs,
    events,
    projector,
    driver,

    migrate: (target = LATEST_VERSION) => migrate(driver, target),
    rollback: (target) => rollback(driver, target),
    schemaVersion: () => currentVersion(driver),

    async rebuild(accountId) {
      projector.dropProjections(accountId);
      await projector.apply(events.all(accountId), (id) => blobs.get(id as BlobId));
    },

    getMessage(id) {
      const row = selectMessage.get(id);
      return row === undefined ? null : hydrate(row);
    },

    queryMessages(query) {
      const where: string[] = ["m.account_id = ?"];
      const params: (string | number)[] = [query.accountId];

      if (query.mailboxId !== undefined) {
        where.push(
          "exists (select 1 from message_mailboxes mm where mm.message_id = m.id and mm.mailbox_id = ?)",
        );
        params.push(query.mailboxId);
      }
      if (query.threadId !== undefined) {
        where.push("m.thread_id = ?");
        params.push(query.threadId);
      }
      if (query.hasKeyword !== undefined) {
        where.push(
          "exists (select 1 from message_keywords mk where mk.message_id = m.id and mk.keyword = ?)",
        );
        params.push(query.hasKeyword);
      }
      if (query.lacksKeyword !== undefined) {
        where.push(
          "not exists (select 1 from message_keywords mk where mk.message_id = m.id and mk.keyword = ?)",
        );
        params.push(query.lacksKeyword);
      }
      if (query.before !== undefined) {
        where.push("m.received_at < ?");
        params.push(query.before);
      }
      params.push(query.limit ?? 50);

      // Newest first, with id as a tiebreak so paging cannot loop or skip when
      // two messages share a received time.
      const sql = `select ${MESSAGE_COLUMNS} from messages m where ${where.join(" and ")}
                   order by m.received_at desc, m.id desc limit ?`;
      return driver
        .prepare(sql)
        .all(...(params as never[]))
        .map(hydrate);
    },

    getThread(id) {
      const row = selectThread.get(id);
      if (row === undefined) return null;
      return {
        id: asString(row.id) as ThreadId,
        accountId: asString(row.account_id) as AccountId,
        messageIds: selectThreadMessages.all(id).map((r) => asString(r.id) as MessageId),
        subject: asString(row.subject),
        participants: parseJson<EmailAddress[]>(row.participants, []),
        lastMessageAt: asString(row.last_message_at) as Instant,
        messageCount: asNumber(row.message_count),
      };
    },

    listMailboxes(accountId) {
      return selectMailboxes.all(accountId).map(
        (row): Mailbox => ({
          id: asString(row.id) as MailboxId,
          accountId: asString(row.account_id) as AccountId,
          providerId: asString(row.provider_id),
          name: asString(row.name),
          parentId: row.parent_id === null ? null : (asString(row.parent_id) as MailboxId),
          role: asString(row.role) as Mailbox["role"],
          sortOrder: asNumber(row.sort_order),
          ...(row.reported_total === null ? {} : { reportedTotal: asNumber(row.reported_total) }),
          ...(row.reported_unread === null
            ? {}
            : { reportedUnread: asNumber(row.reported_unread) }),
        }),
      );
    },

    countMessages: (accountId) => asNumber(countRows.get(accountId)?.n ?? 0),

    snapshot(accountId) {
      const messages = driver
        .prepare(`select ${MESSAGE_COLUMNS} from messages m where m.account_id = ? order by m.id`)
        .all(accountId)
        .map((row) => {
          const message = hydrate(row);
          // thread_id is included: a rebuild that reshapes threads has broken
          // the invariant just as surely as one that loses a subject line.
          return JSON.stringify(message);
        });

      const threads = driver
        .prepare("select * from threads where account_id = ? order by id")
        .all(accountId)
        .map((row) =>
          JSON.stringify({
            id: asString(row.id),
            subject: asString(row.subject),
            participants: parseJson(row.participants, []),
            lastMessageAt: asString(row.last_message_at),
            messageCount: asNumber(row.message_count),
          }),
        );

      const mailboxes = this.listMailboxes(accountId).map((mailbox) => JSON.stringify(mailbox));

      const cursors = driver
        .prepare(
          "select collection, cursor from sync_cursors where account_id = ? order by collection",
        )
        .all(accountId)
        .map((row) =>
          JSON.stringify([asString(row.collection), asOptionalString(row.cursor) ?? null]),
        );

      return { messages, threads, mailboxes, cursors };
    },

    close() {
      driver.close();
    },
  };
};
