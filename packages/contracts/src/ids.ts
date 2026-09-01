import { z } from "zod";

/**
 * Identifiers are branded strings. The brand is compile-time only — it costs
 * nothing at runtime but stops a ThreadId being passed where a MessageId is
 * expected, which is the single most common cross-package mistake.
 *
 * Every id is *local*. Provider-side identifiers never travel as these types;
 * they live in `providerId` fields and stop at the adapter boundary.
 */

const idString = z.string().min(1).max(512);

export const AccountIdSchema = idString.brand<"AccountId">();
export type AccountId = z.infer<typeof AccountIdSchema>;
export const accountId = (value: string): AccountId => AccountIdSchema.parse(value);

export const MessageIdSchema = idString.brand<"MessageId">();
export type MessageId = z.infer<typeof MessageIdSchema>;
export const messageId = (value: string): MessageId => MessageIdSchema.parse(value);

export const ThreadIdSchema = idString.brand<"ThreadId">();
export type ThreadId = z.infer<typeof ThreadIdSchema>;
export const threadId = (value: string): ThreadId => ThreadIdSchema.parse(value);

export const MailboxIdSchema = idString.brand<"MailboxId">();
export type MailboxId = z.infer<typeof MailboxIdSchema>;
export const mailboxId = (value: string): MailboxId => MailboxIdSchema.parse(value);

export const IntentIdSchema = idString.brand<"IntentId">();
export type IntentId = z.infer<typeof IntentIdSchema>;
export const intentId = (value: string): IntentId => IntentIdSchema.parse(value);

export const AnnotationIdSchema = idString.brand<"AnnotationId">();
export type AnnotationId = z.infer<typeof AnnotationIdSchema>;
export const annotationId = (value: string): AnnotationId => AnnotationIdSchema.parse(value);

export const CommandIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9]*(\.[a-z0-9-]+)+$/, "command ids are dotted lowercase, e.g. mail.archive")
  .brand<"CommandId">();
export type CommandId = z.infer<typeof CommandIdSchema>;
export const commandId = (value: string): CommandId => CommandIdSchema.parse(value);

export const PluginIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)*$/, "plugin ids are lowercase dotted or dashed")
  .brand<"PluginId">();
export type PluginId = z.infer<typeof PluginIdSchema>;
export const pluginId = (value: string): PluginId => PluginIdSchema.parse(value);

export const RuleIdSchema = idString.brand<"RuleId">();
export type RuleId = z.infer<typeof RuleIdSchema>;
export const ruleId = (value: string): RuleId => RuleIdSchema.parse(value);

/**
 * Blobs are content-addressed: the id *is* the digest of the bytes. Two
 * accounts holding the same message share one blob. Nothing rewrites a blob;
 * a "changed" message is a new blob.
 */
export const BlobIdSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, "blob ids are `sha256:` followed by 64 lowercase hex chars")
  .brand<"BlobId">();
export type BlobId = z.infer<typeof BlobIdSchema>;
export const blobId = (value: string): BlobId => BlobIdSchema.parse(value);

/** Build a BlobId from a raw lowercase hex sha-256 digest. */
export const blobIdFromDigest = (hexDigest: string): BlobId => blobId(`sha256:${hexDigest}`);
