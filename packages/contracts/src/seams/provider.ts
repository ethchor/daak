import { z } from "zod";
import type { AccountId, BlobId } from "../ids.js";
import type { Intent, IntentOutcome } from "../model/intent.js";
import type { Mailbox } from "../model/mailbox.js";
import type { SyncCollection } from "../model/sync.js";
import type { Cancellable, EmailAddress, Unsubscribe } from "../primitives.js";

/**
 * SEAM 1 — Provider.
 *
 * The only thing in Daak that talks to a mail server. Implemented today by
 * `adapter-mock` and `adapter-jmap`; later by IMAP and whatever exists in 2040.
 *
 * ## Rules an implementation must not break
 *
 * 1. **No provider concept crosses this boundary.** No JMAP `Email/get`
 *    vocabulary, no IMAP UIDs, no Gmail label semantics. Translate, or keep it
 *    inside your package.
 * 2. **Throw `DaakError`, always classified.** Never leak a fetch error.
 * 3. **Never report `applied` for an operation you are not sure applied.**
 *    A timeout after the request left the machine is `unknown`, and the sync
 *    engine knows how to resolve that. Guessing here is how mailboxes corrupt.
 * 4. **Raw bytes are returned untouched.** No re-encoding, no newline
 *    normalisation, no charset conversion. The digest must match the server's.
 */
export const ProviderCapabilitiesSchema = z.object({
  /** Max ids per metadata fetch. The sync engine batches to this. */
  maxObjectsPerFetch: z.number().int().positive(),
  /** Does the provider push changes, or must we poll? */
  supportsPush: z.boolean(),
  /** Can the provider report changes since a cursor, or only full listings? */
  supportsIncrementalChanges: z.boolean(),
  /** Can we upload blobs (needed for send and draft save)? */
  supportsBlobUpload: z.boolean(),
  maxUploadBytes: z.number().int().positive().optional(),
  /** Free-form notes for humans debugging a specific server. Never branched on. */
  quirks: z.array(z.string()).default([]),
});
export type ProviderCapabilities = z.infer<typeof ProviderCapabilitiesSchema>;

/**
 * Metadata as the provider reports it, before it becomes a local `Message`.
 * Keep it minimal: anything derivable from the raw bytes is derived locally,
 * not trusted from the server.
 */
export interface ProviderMessage {
  readonly providerId: string;
  readonly blobId: BlobId | null;
  readonly size: number;
  readonly receivedAt: string;
  readonly keywords: readonly string[];
  /** Provider mailbox ids, not local `MailboxId`s. The sync engine maps them. */
  readonly mailboxProviderIds: readonly string[];
}

export type ProviderChange =
  | { readonly kind: "created" | "updated"; readonly providerId: string }
  | { readonly kind: "destroyed"; readonly providerId: string };

export interface ChangeBatch {
  readonly collection: SyncCollection;
  readonly changes: readonly ProviderChange[];
  /** Opaque state string to pass back next time. */
  readonly cursor: string;
  readonly hasMore: boolean;
}

export interface SubmitRequest extends Cancellable {
  readonly blobId: BlobId;
  readonly mailFrom: EmailAddress;
  readonly rcptTo: readonly EmailAddress[];
  /** Client-generated; the provider must treat it as an idempotency key. */
  readonly idempotencyKey: string;
}

export interface SubmitOutcome {
  readonly status: "accepted" | "rejected" | "unknown";
  readonly providerId?: string;
}

export interface MailProvider {
  readonly kind: string;
  readonly accountId: AccountId;

  capabilities(): Promise<ProviderCapabilities>;

  listMailboxes(options?: Cancellable): Promise<readonly Mailbox[]>;

  /**
   * Changes since `cursor`. A `null` cursor means "start from now" for the tail
   * lane. Historical messages come from {@link backfill}, not from here.
   *
   * Throw a `conflict` `DaakError` with code `sync.cursor_invalid` when the
   * provider has expired the cursor — the engine will resynchronise.
   */
  changes(
    input: { collection: SyncCollection; cursor: string | null; limit: number } & Cancellable,
  ): Promise<ChangeBatch>;

  /** Walk history downwards. Must never block or starve {@link changes}. */
  backfill(
    input: { collection: SyncCollection; lowWatermark: string | null; limit: number } & Cancellable,
  ): Promise<{ items: readonly ProviderMessage[]; lowWatermark: string | null; complete: boolean }>;

  fetchMetadata(
    providerIds: readonly string[],
    options?: Cancellable,
  ): Promise<readonly ProviderMessage[]>;

  /** Full RFC 5322 bytes, exactly as the server holds them. */
  fetchRaw(providerId: string, options?: Cancellable): Promise<Uint8Array>;

  /** Upload bytes so they can be referenced by a later submit or draft save. */
  uploadBlob(bytes: Uint8Array, options?: Cancellable): Promise<{ providerBlobId: string }>;

  /**
   * Push local intents. Outcomes come back in the same order as the input, one
   * per intent. Partial success is normal and expected.
   */
  apply(intents: readonly Intent[], options?: Cancellable): Promise<readonly IntentOutcome[]>;

  submit(request: SubmitRequest): Promise<SubmitOutcome>;

  /** Optional server push. Returns a no-op unsubscribe when unsupported. */
  watch?(onChange: (collection: SyncCollection) => void): Unsubscribe;

  close(): Promise<void>;
}
