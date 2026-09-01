import { z } from "zod";
import {
  AccountIdSchema,
  BlobIdSchema,
  MailboxIdSchema,
  MessageIdSchema,
  ThreadIdSchema,
} from "../ids.js";
import { ByteSizeSchema, EmailAddressSchema, InstantSchema } from "../primitives.js";

/**
 * Keywords follow the JMAP/IMAP convention: `$seen`, `$flagged`, `$draft`,
 * `$answered`, plus arbitrary user keywords. Stored as a sorted unique array —
 * it is a set, and any code that depends on insertion order is wrong.
 */
export const KEYWORD_SEEN = "$seen";
export const KEYWORD_FLAGGED = "$flagged";
export const KEYWORD_DRAFT = "$draft";
export const KEYWORD_ANSWERED = "$answered";
export const KEYWORD_FORWARDED = "$forwarded";

export const KeywordSchema = z.string().min(1).max(64);

/**
 * A message as projected into the store.
 *
 * Everything here is DERIVED from the raw blob plus provider state, and can be
 * rebuilt by re-parsing (ARCHITECTURE.md invariant 2). Nothing in this row is
 * a source of truth; the bytes are.
 */
export const MessageSchema = z.object({
  id: MessageIdSchema,
  accountId: AccountIdSchema,
  /** Content address of the full RFC 5322 bytes. */
  blobId: BlobIdSchema,
  threadId: ThreadIdSchema,
  /** Opaque provider identifier for this message within the account. */
  providerId: z.string(),

  mailboxIds: z.array(MailboxIdSchema),
  keywords: z.array(KeywordSchema),

  /** When the server took delivery. Ordering key for the mailbox list. */
  receivedAt: InstantSchema,
  /** From the `Date` header. Absent or absurd on plenty of real mail. */
  sentAt: InstantSchema.optional(),

  from: z.array(EmailAddressSchema),
  to: z.array(EmailAddressSchema),
  cc: z.array(EmailAddressSchema),
  bcc: z.array(EmailAddressSchema),
  replyTo: z.array(EmailAddressSchema),

  /** RFC 2047-decoded. May be empty; may contain anything. */
  subject: z.string(),

  /** `Message-ID` header value(s), angle brackets stripped. */
  messageIdHeader: z.array(z.string()),
  inReplyTo: z.array(z.string()),
  references: z.array(z.string()),
  /** `List-Id`, when present. The cheapest reliable bulk-mail signal there is. */
  listId: z.string().optional(),

  size: ByteSizeSchema,
  hasAttachment: z.boolean(),
  /** Short plain-text preview. Bounded so list rendering never touches a body. */
  preview: z.string().max(512),
});
export type Message = z.infer<typeof MessageSchema>;

/** Sort and de-duplicate keywords. The one blessed way to normalise a keyword set. */
export const normaliseKeywords = (keywords: readonly string[]): string[] =>
  [...new Set(keywords)].sort();
