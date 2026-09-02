import type { MailboxRole, ProviderMailbox, ProviderMessage } from "@daak/contracts";

/**
 * JMAP shapes into provider shapes.
 *
 * This file is the boundary. Nothing above it sees a JMAP keyword map, a role
 * string, or a state string — and the test for that is that deleting this
 * package and writing an IMAP one requires no change further up.
 */

/** Properties worth asking for. Anything else is derived from the bytes. */
export const EMAIL_PROPERTIES = [
  "id",
  "blobId",
  "size",
  "receivedAt",
  "keywords",
  "mailboxIds",
] as const;

/**
 * RFC 8621 §2 roles onto ours.
 *
 * `flagged`, `important` and `subscribed` are real JMAP roles with no
 * equivalent here: they are views, not mailboxes a message lives in. Mapping
 * them to `none` keeps them visible as ordinary mailboxes rather than
 * pretending they are an inbox.
 */
const ROLES: Record<string, MailboxRole> = {
  inbox: "inbox",
  archive: "archive",
  drafts: "drafts",
  sent: "sent",
  trash: "trash",
  junk: "junk",
  all: "all",
  snoozed: "snoozed",
};

export const toMailboxRole = (role: unknown): MailboxRole =>
  typeof role === "string" ? (ROLES[role.toLowerCase()] ?? "none") : "none";

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

/** JMAP writes sets as `{key: true}` maps. Only truthy entries count. */
export const keysOf = (value: unknown): string[] =>
  Object.entries(asRecord(value))
    .filter(([, present]) => present === true)
    .map(([key]) => key)
    .sort();

export const toProviderMailbox = (raw: unknown): ProviderMailbox => {
  const mailbox = asRecord(raw);
  const parent = mailbox.parentId;
  return {
    providerId: String(mailbox.id ?? ""),
    name: String(mailbox.name ?? ""),
    parentProviderId: typeof parent === "string" && parent !== "" ? parent : null,
    role: toMailboxRole(mailbox.role),
    sortOrder: typeof mailbox.sortOrder === "number" ? mailbox.sortOrder : 0,
    ...(typeof mailbox.totalEmails === "number" ? { reportedTotal: mailbox.totalEmails } : {}),
    ...(typeof mailbox.unreadEmails === "number" ? { reportedUnread: mailbox.unreadEmails } : {}),
  };
};

export const toProviderMessage = (raw: unknown): ProviderMessage => {
  const email = asRecord(raw);
  const blobId = email.blobId;
  return {
    providerId: String(email.id ?? ""),
    // Opaque to us and not a digest of anything. The local content address is
    // computed when the bytes arrive.
    providerBlobId: typeof blobId === "string" && blobId !== "" ? blobId : null,
    size: typeof email.size === "number" ? email.size : 0,
    receivedAt: String(email.receivedAt ?? ""),
    keywords: keysOf(email.keywords),
    mailboxProviderIds: keysOf(email.mailboxIds),
  };
};

/**
 * JSON Pointer escaping for a patch key (RFC 6901).
 *
 * User keywords may contain `/` and `~`, and an unescaped one silently patches
 * a different path — or a nested object that does not exist.
 */
export const escapePointer = (segment: string): string =>
  segment.replace(/~/g, "~0").replace(/\//g, "~1");

/**
 * A JMAP patch for an add/remove pair.
 *
 * `true` adds, `null` removes — RFC 8621 §4.6. Expressing it as a patch rather
 * than a whole-object update is what makes concurrent changes to *other*
 * keywords survive: we never send a complete set we might have read stale.
 */
export const buildPatch = (
  property: "keywords" | "mailboxIds",
  add: readonly string[],
  remove: readonly string[],
): Record<string, true | null> => {
  const patch: Record<string, true | null> = {};
  for (const value of remove) patch[`${property}/${escapePointer(value)}`] = null;
  // Add wins on a value that appears in both: it is the later intent.
  for (const value of add) patch[`${property}/${escapePointer(value)}`] = true;
  return patch;
};
