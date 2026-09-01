import type { EmailAddress, Instant, MessageId } from "@daak/contracts";

/**
 * What threading needs from a message, and nothing more.
 *
 * Headers only. If an implementation here ever reaches for a body, it has taken
 * a wrong turn — JWZ is a header algorithm, and bodies are expensive to load
 * for the 500k-message case this has to survive.
 *
 * `Message` from `@daak/contracts` satisfies this structurally, so the store can
 * pass rows straight in.
 */
export interface ThreadableMessage {
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
