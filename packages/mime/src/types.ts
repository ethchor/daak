import type { EmailAddress, Instant } from "@daak/contracts";

/**
 * A message, projected.
 *
 * The raw bytes stay canonical — parsing never mutates them and nothing here is
 * a source of truth. Everything in this shape can be recomputed by re-parsing
 * the blob, which is what makes ARCHITECTURE.md invariant 2 hold.
 */
export interface ParsedMessage {
  /** Header-derived fields, in exactly the shape `Message` wants them. */
  readonly envelope: Envelope;
  /** Content types depth-first, container before children. */
  readonly structure: readonly string[];
  readonly parts: MimePart;
  readonly text: string | undefined;
  readonly html: string | undefined;
  /** What a user would call an attachment. Not signatures, not inline images. */
  readonly attachments: readonly Attachment[];
  /** Parts referenced from the HTML by `cid:`. Rendered, never listed. */
  readonly inlineParts: readonly InlinePart[];
  readonly hasAttachment: boolean;
  readonly preview: string;
  readonly size: number;
  /**
   * What could not be parsed cleanly.
   *
   * Real mail is malformed, so this is how the parser degrades: return what was
   * understood, say what was not. Only input that is not a message at all
   * throws.
   */
  readonly warnings: readonly ParseWarning[];
}

export interface Envelope {
  readonly subject: string;
  readonly from: readonly EmailAddress[];
  readonly to: readonly EmailAddress[];
  readonly cc: readonly EmailAddress[];
  readonly bcc: readonly EmailAddress[];
  readonly replyTo: readonly EmailAddress[];
  /** Angle brackets stripped. Plural because broken senders emit more than one. */
  readonly messageIdHeader: readonly string[];
  readonly inReplyTo: readonly string[];
  readonly references: readonly string[];
  readonly listId: string | undefined;
  /**
   * From the `Date` header, when it is a real date.
   *
   * Absent when the header is missing or nonsense. Never substituted with the
   * current time — that silently reorders someone's mailbox, and the server's
   * received time is the ordering key anyway.
   */
  readonly sentAt: Instant | undefined;
}

export interface MimePart {
  /** Lowercased `type/subtype`. `text/plain` when the header is absent. */
  readonly contentType: string;
  readonly parameters: Readonly<Record<string, string>>;
  readonly children: readonly MimePart[];
}

export interface Attachment {
  /** As it appeared. Null when the message did not name the part. */
  readonly filename: string | null;
  /** Always present: synthesised from the content type when `filename` is null. */
  readonly displayName: string;
  readonly contentType: string;
  readonly size: number;
  readonly content: Uint8Array;
}

export interface InlinePart {
  readonly contentId: string;
  readonly contentType: string;
  readonly filename: string | null;
  readonly size: number;
  readonly content: Uint8Array;
}

export const PARSE_WARNINGS = [
  "date.unparseable",
  "date.missing",
  "boundary.unclosed",
  "boundary.missing",
  "structure.depth-exceeded",
  "address.malformed",
  "message-id.missing",
] as const;
export type ParseWarningCode = (typeof PARSE_WARNINGS)[number];

export interface ParseWarning {
  readonly code: ParseWarningCode;
  /** Never contains message content — warnings are logged and shown to agents. */
  readonly detail?: string;
}

export interface ParseOptions {
  /** Refuse to descend further. Guards against a hostile nesting bomb. */
  readonly maxDepth?: number;
  /** Cap on the preview. `Message.preview` is capped at 512 by contract. */
  readonly previewLength?: number;
}
