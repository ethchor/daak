import { z } from "zod";
import { AccountIdSchema } from "../ids.js";
import { EmailAddressSchema, InstantSchema } from "../primitives.js";

/**
 * An account is a (provider, identity) pair plus a reference to credentials.
 *
 * Credentials themselves are NEVER persisted in the store. `secretRef` names an
 * entry in the platform keychain / OS credential store. A dump of the SQLite
 * database must not be enough to read someone's mail.
 */
export const ProviderKindSchema = z.enum(["mock", "jmap", "imap"]);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

export const AccountSchema = z.object({
  id: AccountIdSchema,
  providerKind: ProviderKindSchema,
  /** Human label. User-editable, never used as a key. */
  name: z.string(),
  /** Identities this account can send as. */
  identities: z.array(EmailAddressSchema),
  /** Base URL / host the adapter talks to. No credentials in here. */
  endpoint: z.string().optional(),
  /** Opaque handle into the OS credential store. Never a secret itself. */
  secretRef: z.string().optional(),
  createdAt: InstantSchema,
  /** Set when the user pauses an account; sync must not run. */
  disabledAt: InstantSchema.optional(),
});
export type Account = z.infer<typeof AccountSchema>;
