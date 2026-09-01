import { z } from "zod";
import { AccountIdSchema } from "../ids.js";
import { InstantSchema } from "../primitives.js";

/** The collections a provider tracks changes for, provider-independently. */
export const SyncCollectionSchema = z.enum(["mailbox", "message", "submission"]);
export type SyncCollection = z.infer<typeof SyncCollectionSchema>;

/**
 * Sync runs two independent lanes per account:
 *
 * - **tail**: keeps up with new changes. Never blocked by backfill.
 * - **backfill**: walks history downwards. Never blocks the tail.
 *
 * Their progress is tracked separately so a stalled backfill can never stop
 * new mail arriving.
 */
export const SyncCursorSchema = z.object({
  accountId: AccountIdSchema,
  collection: SyncCollectionSchema,
  /** Opaque provider state string. Never parsed outside the adapter. */
  cursor: z.string().nullable(),
  updatedAt: InstantSchema,
});
export type SyncCursor = z.infer<typeof SyncCursorSchema>;

export const BackfillProgressSchema = z.object({
  accountId: AccountIdSchema,
  collection: SyncCollectionSchema,
  /** Oldest point reached so far. Opaque; provider-defined ordering. */
  lowWatermark: z.string().nullable(),
  complete: z.boolean(),
  updatedAt: InstantSchema,
});
export type BackfillProgress = z.infer<typeof BackfillProgressSchema>;

export const SyncPhaseSchema = z.enum(["idle", "tailing", "backfilling", "pushing", "error"]);
export type SyncPhase = z.infer<typeof SyncPhaseSchema>;

/** What the UI renders as sync status. Cheap to compute, safe to poll. */
export const SyncStatusSchema = z.object({
  accountId: AccountIdSchema,
  phase: SyncPhaseSchema,
  pendingIntents: z.number().int().nonnegative(),
  /** Present when phase is `error`. */
  lastErrorCode: z.string().optional(),
  lastSyncedAt: InstantSchema.optional(),
});
export type SyncStatus = z.infer<typeof SyncStatusSchema>;
