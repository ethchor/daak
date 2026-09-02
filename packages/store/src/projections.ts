import {
  type AccountId,
  type EmailAddress,
  type Event,
  type Instant,
  type Mailbox,
  type MessageId,
  normaliseKeywords,
  type Thread,
  type ThreadId,
} from "@daak/contracts";
import { asNumber, asString, prepareLazily, type SqliteDriver, toSqlBool } from "./driver.js";

/**
 * Projections: the derived half of the schema.
 *
 * Everything written here can be dropped and rebuilt from `blobs` + `events`
 * (ARCHITECTURE.md invariant 2), and `rebuild()` below is what proves it rather
 * than asserting it.
 *
 * ## Why the resolvers are injected
 *
 * Deriving a message's subject means parsing its bytes, and grouping messages
 * into threads means running JWZ. Both live in other packages, and `store` is
 * not allowed to import them — its dependency list is `@daak/contracts` and a
 * SQLite driver, and that boundary is what keeps the store testable without a
 * parser and the parser testable without a database.
 *
 * So the caller supplies them. In production `@daak/sync` wires up
 * `@daak/mime` and `@daak/threading`; in tests here a trivial pair stands in.
 */
export interface MessageFields {
  readonly subject: string;
  readonly from: readonly EmailAddress[];
  readonly to: readonly EmailAddress[];
  readonly cc: readonly EmailAddress[];
  readonly bcc: readonly EmailAddress[];
  readonly replyTo: readonly EmailAddress[];
  readonly messageIdHeader: readonly string[];
  readonly inReplyTo: readonly string[];
  readonly references: readonly string[];
  readonly listId: string | undefined;
  readonly sentAt: Instant | undefined;
  readonly hasAttachment: boolean;
  readonly preview: string;
}

export interface ThreadInput {
  readonly id: MessageId;
  readonly messageIdHeader: readonly string[];
  readonly inReplyTo: readonly string[];
  readonly references: readonly string[];
  readonly subject: string;
  readonly receivedAt: Instant;
  readonly from: readonly EmailAddress[];
  readonly to: readonly EmailAddress[];
  readonly cc: readonly EmailAddress[];
}

export interface Projectors {
  /** Derive message fields from raw bytes. Backed by `@daak/mime`. */
  resolveMessage(raw: Uint8Array): Promise<MessageFields>;
  /** Group messages into threads. Backed by `@daak/threading`. */
  threadMessages(input: { accountId: AccountId; messages: readonly ThreadInput[] }): Thread[];
}

const json = (value: unknown): string => JSON.stringify(value);
const parseJson = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== "string" || value === "") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

export interface Projector {
  apply(events: readonly Event[], readBlob: (id: string) => Promise<Uint8Array>): Promise<void>;
  recomputeThreads(accountId: AccountId): void;
  /** Drop every projection for an account. Sources of truth are untouched. */
  dropProjections(accountId: AccountId): void;
}

export const createProjector = (driver: SqliteDriver, projectors: Projectors): Projector => {
  const upsertMessage = prepareLazily(
    driver,
    `
    insert into messages (
      id, account_id, blob_id, thread_id, provider_id, received_at, sent_at, subject,
      addr_from, addr_to, addr_cc, addr_bcc, addr_reply_to,
      message_id_header, in_reply_to, refs, list_id, size, has_attachment, preview
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict (id) do update set
      blob_id = excluded.blob_id, received_at = excluded.received_at,
      sent_at = excluded.sent_at, subject = excluded.subject,
      addr_from = excluded.addr_from, addr_to = excluded.addr_to,
      addr_cc = excluded.addr_cc, addr_bcc = excluded.addr_bcc,
      addr_reply_to = excluded.addr_reply_to,
      message_id_header = excluded.message_id_header, in_reply_to = excluded.in_reply_to,
      refs = excluded.refs, list_id = excluded.list_id, size = excluded.size,
      has_attachment = excluded.has_attachment, preview = excluded.preview
  `,
  );
  const deleteMessage = prepareLazily(driver, "delete from messages where id = ?");
  const blobSize = prepareLazily(driver, "select size from blobs where id = ?");
  const messageExists = prepareLazily(driver, "select 1 as ok from messages where id = ?");

  const clearKeywords = prepareLazily(driver, "delete from message_keywords where message_id = ?");
  const addKeyword = prepareLazily(
    driver,
    "insert or ignore into message_keywords (message_id, keyword) values (?, ?)",
  );
  const clearMailboxes = prepareLazily(
    driver,
    "delete from message_mailboxes where message_id = ?",
  );
  const addMailbox = prepareLazily(
    driver,
    "insert or ignore into message_mailboxes (message_id, mailbox_id) values (?, ?)",
  );

  const upsertMailbox = prepareLazily(
    driver,
    `
    insert into mailboxes (id, account_id, provider_id, name, parent_id, role, sort_order,
                           reported_total, reported_unread)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict (id) do update set
      name = excluded.name, parent_id = excluded.parent_id, role = excluded.role,
      sort_order = excluded.sort_order, reported_total = excluded.reported_total,
      reported_unread = excluded.reported_unread
  `,
  );
  const deleteMailbox = prepareLazily(driver, "delete from mailboxes where id = ?");

  const setCursor = prepareLazily(
    driver,
    `
    insert into sync_cursors (account_id, collection, cursor, updated_at) values (?, ?, ?, ?)
    on conflict (account_id, collection) do update set
      cursor = excluded.cursor, updated_at = excluded.updated_at
  `,
  );

  const selectThreadInputs = prepareLazily(
    driver,
    `
    select id, message_id_header, in_reply_to, refs, subject, received_at,
           addr_from, addr_to, addr_cc
    from messages where account_id = ? order by received_at, id
  `,
  );
  const clearThreads = prepareLazily(driver, "delete from threads where account_id = ?");
  const insertThread = prepareLazily(
    driver,
    `
    insert into threads (id, account_id, subject, participants, last_message_at, message_count)
    values (?, ?, ?, ?, ?, ?)
  `,
  );
  const setMessageThread = prepareLazily(driver, "update messages set thread_id = ? where id = ?");

  const dropForAccount = [
    prepareLazily(
      driver,
      "delete from message_keywords where message_id in (select id from messages where account_id = ?)",
    ),
    prepareLazily(
      driver,
      "delete from message_mailboxes where message_id in (select id from messages where account_id = ?)",
    ),
    prepareLazily(driver, "delete from threads where account_id = ?"),
    prepareLazily(driver, "delete from messages where account_id = ?"),
    prepareLazily(driver, "delete from mailboxes where account_id = ?"),
    // The full-text index is a projection too. Leaving stale rows behind after
    // a rebuild would mean searching a mailbox that no longer exists;
    // repopulating it is @daak/search's job.
    prepareLazily(driver, "delete from message_fts where account_id = ?"),
  ];

  const recomputeThreads = (accountId: AccountId): void => {
    const rows = selectThreadInputs.all(accountId);
    const messages: ThreadInput[] = rows.map((row) => ({
      id: asString(row.id) as MessageId,
      messageIdHeader: parseJson<string[]>(row.message_id_header, []),
      inReplyTo: parseJson<string[]>(row.in_reply_to, []),
      references: parseJson<string[]>(row.refs, []),
      subject: asString(row.subject),
      receivedAt: asString(row.received_at) as Instant,
      from: parseJson<EmailAddress[]>(row.addr_from, []),
      to: parseJson<EmailAddress[]>(row.addr_to, []),
      cc: parseJson<EmailAddress[]>(row.addr_cc, []),
    }));

    const threads = projectors.threadMessages({ accountId, messages });

    driver.transaction(() => {
      clearThreads.run(accountId);
      for (const thread of threads) {
        insertThread.run(
          thread.id,
          thread.accountId,
          thread.subject,
          json(thread.participants),
          thread.lastMessageAt,
          thread.messageCount,
        );
        for (const messageId of thread.messageIds) {
          setMessageThread.run(thread.id, messageId);
        }
      }
    });
  };

  const applyOne = async (
    event: Event,
    readBlob: (id: string) => Promise<Uint8Array>,
  ): Promise<boolean> => {
    const payload = event.payload;
    switch (payload.type) {
      case "blob.stored":
        // The bytes are already in `blobs`; the event exists so a replay knows
        // the blob was expected to be there.
        return false;

      case "message.observed": {
        const raw = await readBlob(payload.blobId);
        const fields = await projectors.resolveMessage(raw);
        const size = asNumber(blobSize.get(payload.blobId)?.size ?? raw.byteLength);
        driver.transaction(() => {
          upsertMessage.run(
            payload.messageId,
            event.accountId,
            payload.blobId,
            // Placeholder until threading runs. thread_id is a projection
            // column like any other, and recomputeThreads owns it.
            payload.messageId,
            payload.providerId,
            payload.receivedAt,
            fields.sentAt ?? null,
            fields.subject,
            json(fields.from),
            json(fields.to),
            json(fields.cc),
            json(fields.bcc),
            json(fields.replyTo),
            json(fields.messageIdHeader),
            json(fields.inReplyTo),
            json(fields.references),
            fields.listId ?? null,
            size,
            toSqlBool(fields.hasAttachment),
            fields.preview,
          );
        });
        return true;
      }

      case "message.keywords.set":
        // A set operation on a message that is not here has nothing to project.
        // This is not defensive coding: replaying a log that contains a removal
        // followed by a late-arriving flag change must not throw, or the whole
        // account becomes unrebuildable — permanently, and only discovered the
        // first time someone needs a rebuild. A property test found exactly
        // this sequence on its first run.
        if (messageExists.get(payload.messageId) === undefined) return false;
        driver.transaction(() => {
          clearKeywords.run(payload.messageId);
          for (const keyword of normaliseKeywords(payload.keywords)) {
            addKeyword.run(payload.messageId, keyword);
          }
        });
        return false;

      case "message.mailboxes.set":
        if (messageExists.get(payload.messageId) === undefined) return false;
        driver.transaction(() => {
          clearMailboxes.run(payload.messageId);
          for (const mailboxId of [...new Set(payload.mailboxIds)].sort()) {
            addMailbox.run(payload.messageId, mailboxId);
          }
        });
        return false;

      case "message.removed":
        // Cascades take the keyword and mailbox rows with it.
        deleteMessage.run(payload.messageId);
        return true;

      case "mailbox.upserted": {
        const mailbox: Mailbox = payload.mailbox;
        upsertMailbox.run(
          mailbox.id,
          mailbox.accountId,
          mailbox.providerId,
          mailbox.name,
          mailbox.parentId,
          mailbox.role,
          mailbox.sortOrder,
          mailbox.reportedTotal ?? null,
          mailbox.reportedUnread ?? null,
        );
        return false;
      }

      case "mailbox.removed":
        deleteMailbox.run(payload.mailboxId);
        return false;

      case "sync.cursor.advanced":
        setCursor.run(event.accountId, payload.collection, payload.cursor, event.at);
        return false;
    }
  };

  return {
    async apply(events, readBlob) {
      const touchedAccounts = new Set<AccountId>();
      for (const event of events) {
        // Threading is recomputed once per batch rather than per event: it is
        // O(messages) and running it 10,000 times during a backfill is the
        // difference between seconds and hours.
        if (await applyOne(event, readBlob)) touchedAccounts.add(event.accountId);
      }
      for (const accountId of touchedAccounts) recomputeThreads(accountId);
    },

    recomputeThreads,

    dropProjections(accountId) {
      driver.transaction(() => {
        for (const statement of dropForAccount) statement.run(accountId);
      });
    },
  };
};

/** Read a thread row back out. Exposed for tests and for the read API. */
export const rowToThread = (row: Record<string, unknown>): Thread => ({
  id: asString(row.id) as ThreadId,
  accountId: asString(row.account_id) as AccountId,
  messageIds: [],
  subject: asString(row.subject),
  participants: parseJson<EmailAddress[]>(row.participants, []),
  lastMessageAt: asString(row.last_message_at) as Instant,
  messageCount: asNumber(row.message_count),
});
