import type { AccountId, MessageId } from "@daak/contracts";
import type { Store } from "@daak/store";

/**
 * What goes into the index for one message.
 *
 * The caller builds these. Extracting body text means parsing the bytes, which
 * is `@daak/mime`'s job and not something this package is allowed to import —
 * the same boundary the store draws with its projectors, and for the same
 * reason: search stays testable without a parser, and the parser without a
 * database.
 */
export interface SearchDocument {
  readonly messageId: MessageId;
  readonly accountId: AccountId;
  readonly subject: string;
  /** Display names and addresses of the sender, space separated. */
  readonly sender: string;
  /** Everyone else on the message: to, cc, reply-to. */
  readonly recipients: string;
  /** Decoded plain text. HTML should be stripped before it gets here. */
  readonly body: string;
}

export interface SearchIndex {
  /** Add or replace documents. Idempotent: re-indexing the same id is safe. */
  index(documents: readonly SearchDocument[]): void;
  remove(messageIds: readonly MessageId[]): void;
  /** Drop everything for an account, for a rebuild. */
  clear(accountId: AccountId): void;
  count(accountId: AccountId): number;
}

export const createSearchIndex = (store: Store): SearchIndex => {
  const { driver } = store;

  const remove = driver.prepare("delete from message_fts where message_id = ?");
  const insert = driver.prepare(
    `insert into message_fts (message_id, account_id, subject, sender, recipients, body)
     values (?, ?, ?, ?, ?, ?)`,
  );
  const clearAccount = driver.prepare("delete from message_fts where account_id = ?");
  const countRows = driver.prepare("select count(*) as n from message_fts where account_id = ?");

  return {
    index(documents) {
      if (documents.length === 0) return;
      driver.transaction(() => {
        for (const document of documents) {
          // FTS5 has no upsert. Delete then insert is the documented way, and
          // doing it unconditionally is what makes re-indexing idempotent —
          // which matters because a message is re-indexed every time its
          // keywords change.
          remove.run(document.messageId);
          insert.run(
            document.messageId,
            document.accountId,
            document.subject,
            document.sender,
            document.recipients,
            document.body,
          );
        }
      });
    },

    remove(messageIds) {
      if (messageIds.length === 0) return;
      driver.transaction(() => {
        for (const messageId of messageIds) remove.run(messageId);
      });
    },

    clear(accountId) {
      clearAccount.run(accountId);
    },

    count(accountId) {
      const row = countRows.get(accountId);
      const value = row?.n;
      return typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : 0;
    },
  };
};
