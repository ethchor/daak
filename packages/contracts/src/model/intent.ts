import { z } from "zod";
import { SerializedDaakErrorSchema } from "../errors.js";
import {
  AccountIdSchema,
  BlobIdSchema,
  IntentIdSchema,
  MailboxIdSchema,
  MessageIdSchema,
} from "../ids.js";
import { EmailAddressSchema, InstantSchema } from "../primitives.js";
import { KeywordSchema } from "./message.js";

/**
 * Every local mutation is an intent: recorded first, applied optimistically,
 * then pushed. Nothing writes provider-visible state any other way.
 *
 * Two properties matter more than anything else in this file:
 *
 * 1. **Idempotent.** The `id` is client-generated and travels to the provider.
 *    Replaying an intent that already applied is a no-op, so a retry after an
 *    ambiguous failure is always safe.
 * 2. **Absolute, not relative.** Operations state add/remove sets rather than
 *    "toggle", so replaying out of order converges.
 */
export const IntentOpSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("keywords.change"),
    messageIds: z.array(MessageIdSchema).min(1),
    add: z.array(KeywordSchema).default([]),
    remove: z.array(KeywordSchema).default([]),
  }),
  z.object({
    op: z.literal("mailboxes.change"),
    messageIds: z.array(MessageIdSchema).min(1),
    add: z.array(MailboxIdSchema).default([]),
    remove: z.array(MailboxIdSchema).default([]),
  }),
  z.object({
    op: z.literal("message.destroy"),
    messageIds: z.array(MessageIdSchema).min(1),
  }),
  z.object({
    op: z.literal("draft.save"),
    /** The draft's own content-addressed bytes. Drafts are messages too. */
    blobId: BlobIdSchema,
    mailboxId: MailboxIdSchema,
    /** Set when replacing a previously saved draft. */
    replacesMessageId: MessageIdSchema.optional(),
  }),
  z.object({
    op: z.literal("message.send"),
    blobId: BlobIdSchema,
    envelope: z.object({
      mailFrom: EmailAddressSchema,
      rcptTo: z.array(EmailAddressSchema).min(1),
    }),
  }),
  z.object({
    op: z.literal("mailbox.create"),
    name: z.string().min(1),
    parentId: MailboxIdSchema.nullable(),
  }),
  z.object({
    op: z.literal("mailbox.rename"),
    mailboxId: MailboxIdSchema,
    name: z.string().min(1),
  }),
  z.object({
    op: z.literal("mailbox.destroy"),
    mailboxId: MailboxIdSchema,
  }),
]);
export type IntentOp = z.infer<typeof IntentOpSchema>;

export const IntentStateSchema = z.enum([
  /** Recorded locally, not yet sent. */
  "pending",
  /** Sent; no outcome yet. */
  "inflight",
  /** Provider confirmed. */
  "settled",
  /** Provider refused. Local optimistic state must be rolled back. */
  "rejected",
  /**
   * Sent, outcome unknown — the ambiguous timeout. MUST be resolved by
   * observing server state, never by blindly resending a non-idempotent op.
   */
  "unknown",
]);
export type IntentState = z.infer<typeof IntentStateSchema>;

export const IntentSchema = z.object({
  /** Client-generated. Travels to the provider as the idempotency key. */
  id: IntentIdSchema,
  accountId: AccountIdSchema,
  createdAt: InstantSchema,
  op: IntentOpSchema,
  state: IntentStateSchema,
  attempts: z.number().int().nonnegative().default(0),
  lastAttemptAt: InstantSchema.optional(),
  lastError: SerializedDaakErrorSchema.optional(),
});
export type Intent = z.infer<typeof IntentSchema>;

/** What a provider reports back per intent. */
export const IntentOutcomeSchema = z.object({
  intentId: IntentIdSchema,
  status: z.enum(["applied", "rejected", "unknown"]),
  error: SerializedDaakErrorSchema.optional(),
  /** Provider state string after the change, when the provider gives one. */
  cursor: z.string().optional(),
  /**
   * Set when the mutation created something server-side (a saved draft, a new
   * mailbox). The engine maps it to a local id; without it, a created object is
   * only discoverable on the next sync, which makes the UI lie in between.
   */
  createdProviderId: z.string().optional(),
});
export type IntentOutcome = z.infer<typeof IntentOutcomeSchema>;
