import { z } from "zod";
import { AccountIdSchema, MailboxIdSchema } from "../ids.js";

/**
 * Roles are the provider-independent meaning of a mailbox. Adapters map their
 * own concepts (JMAP roles, IMAP SPECIAL-USE, Gmail labels) onto this list;
 * nothing above the adapter may branch on provider-specific names.
 */
export const MailboxRoleSchema = z.enum([
  "inbox",
  "archive",
  "drafts",
  "sent",
  "trash",
  "junk",
  "all",
  "snoozed",
  "none",
]);
export type MailboxRole = z.infer<typeof MailboxRoleSchema>;

export const MailboxSchema = z.object({
  id: MailboxIdSchema,
  accountId: AccountIdSchema,
  /** Opaque provider identifier. Stops at the adapter boundary. */
  providerId: z.string(),
  name: z.string(),
  parentId: MailboxIdSchema.nullable(),
  role: MailboxRoleSchema,
  sortOrder: z.number().int().default(0),
  /** Provider-reported counts. Advisory only — local counts are authoritative. */
  reportedTotal: z.number().int().nonnegative().optional(),
  reportedUnread: z.number().int().nonnegative().optional(),
});
export type Mailbox = z.infer<typeof MailboxSchema>;
