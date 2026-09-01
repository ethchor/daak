import { z } from "zod";
import { AccountIdSchema, MessageIdSchema, ThreadIdSchema } from "../ids.js";
import { EmailAddressSchema, InstantSchema } from "../primitives.js";

/**
 * Threads are computed locally by `@daak/threading`, never taken from the
 * provider — providers disagree with each other and with themselves, and a
 * thread that changes shape when you switch provider is a bug users can see.
 *
 * A provider's own thread id may be kept for reconciliation, but it must not
 * decide local grouping.
 */
export const ThreadSchema = z.object({
  id: ThreadIdSchema,
  accountId: AccountIdSchema,
  /** Message ids in ascending receivedAt order. */
  messageIds: z.array(MessageIdSchema),
  /** Subject of the root message, with reply/forward prefixes stripped. */
  subject: z.string(),
  participants: z.array(EmailAddressSchema),
  lastMessageAt: InstantSchema,
  messageCount: z.number().int().positive(),
});
export type Thread = z.infer<typeof ThreadSchema>;
