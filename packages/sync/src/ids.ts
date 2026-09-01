import type { AccountId } from "@daak/contracts";

/**
 * Local ids, derived deterministically from provider ids.
 *
 * Derived rather than allocated, because a rebuild has to produce the same ids
 * it produced last time. A counter would renumber everything on a rebuild and
 * every message would look new — annotations orphaned, threads reshaped, read
 * state adrift.
 *
 * The account is part of the derivation so two accounts holding the same
 * provider id do not collide.
 *
 * ## The caveat, stated where someone will find it
 *
 * This ties local identity to provider identity. For JMAP that is safe: ids are
 * stable for the life of the account. For IMAP it is not — a UIDVALIDITY change
 * renumbers a mailbox, and every message in it would be seen as new. The IMAP
 * adapter will need to absorb that below this boundary, by keeping its own
 * stable id and treating a validity change as a remap rather than a delivery.
 */
const SEPARATOR = ":";

export const localMessageId = (accountId: AccountId, providerId: string): string =>
  `m${SEPARATOR}${accountId}${SEPARATOR}${providerId}`;

export const localMailboxId = (accountId: AccountId, providerId: string): string =>
  `mb${SEPARATOR}${accountId}${SEPARATOR}${providerId}`;

/** Recover the provider id from a local one. Only the engine may do this. */
export const providerIdOf = (localId: string): string => {
  const parts = localId.split(SEPARATOR);
  // The provider id may itself contain separators; everything after the
  // account is part of it.
  return parts.slice(2).join(SEPARATOR);
};
