import { z } from "zod";
import { AccountIdSchema, BlobIdSchema, MailboxIdSchema, MessageIdSchema } from "../ids.js";
import { ByteSizeSchema, InstantSchema } from "../primitives.js";
import { MailboxSchema } from "./mailbox.js";
import { KeywordSchema } from "./message.js";

/**
 * The event log is one of the two sources of truth (the other is `blobs`).
 *
 * ARCHITECTURE.md invariant 2: every other table must be rebuildable from
 * `blobs` + `events`. That means an event carries everything needed to replay
 * the state change, and nothing derived — no subject lines, no previews, no
 * thread ids. Those come back from re-parsing the blob.
 *
 * Events are append-only. Nothing updates or deletes a row.
 */
export const EventPayloadSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("blob.stored"),
    blobId: BlobIdSchema,
    size: ByteSizeSchema,
  }),
  z.object({
    type: z.literal("message.observed"),
    messageId: MessageIdSchema,
    blobId: BlobIdSchema,
    providerId: z.string(),
    receivedAt: InstantSchema,
  }),
  z.object({
    type: z.literal("message.keywords.set"),
    messageId: MessageIdSchema,
    /** The complete keyword set after the change, not a delta. */
    keywords: z.array(KeywordSchema),
  }),
  z.object({
    type: z.literal("message.mailboxes.set"),
    messageId: MessageIdSchema,
    /** The complete mailbox set after the change, not a delta. */
    mailboxIds: z.array(MailboxIdSchema),
  }),
  z.object({
    type: z.literal("message.removed"),
    messageId: MessageIdSchema,
  }),
  z.object({
    type: z.literal("mailbox.upserted"),
    mailbox: MailboxSchema,
  }),
  z.object({
    type: z.literal("mailbox.removed"),
    mailboxId: MailboxIdSchema,
  }),
  z.object({
    type: z.literal("sync.cursor.advanced"),
    collection: z.string(),
    cursor: z.string(),
  }),
]);
export type EventPayload = z.infer<typeof EventPayloadSchema>;
export type EventType = EventPayload["type"];

export const EventSchema = z.object({
  /** Monotonic per account. Assigned by the store, never by a caller. */
  seq: z.number().int().nonnegative(),
  accountId: AccountIdSchema,
  at: InstantSchema,
  /** The origin of the change: sync from the server, or a local intent. */
  source: z.enum(["remote", "local", "rebuild"]),
  payload: EventPayloadSchema,
});
export type Event = z.infer<typeof EventSchema>;
