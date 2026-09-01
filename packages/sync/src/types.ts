import type {
  AccountId,
  Cancellable,
  Instant,
  Intent,
  IntentOp,
  MailProvider,
  SyncStatus,
} from "@daak/contracts";
import type { Store } from "@daak/store";

/**
 * The sync engine's public surface.
 *
 * Declared before any of it is implemented, because this is the package where
 * agent-written code is most likely to be *plausibly* wrong — correct-looking,
 * passing the obvious tests, and corrupting state on the third reconnect. The
 * properties in `test/convergence.test.ts` are written against this shape and
 * were reviewed before the logic existed.
 *
 * ## Why there are no timers in here
 *
 * Every pass is a method the caller invokes. Nothing schedules itself. That is
 * what lets a property test drive ten thousand rounds of sync in a second, and
 * it means a test never sleeps, never races, and reproduces from a seed. The
 * loop that calls these on a schedule belongs to the application, not here.
 */
export interface SyncEngineOptions {
  readonly accountId: AccountId;
  readonly provider: MailProvider;
  readonly store: Store;
  /** How many changes to request per pass. Clamped to the provider's own limit. */
  readonly pageSize?: number;
  /**
   * Injected so tests do not sleep. Returns milliseconds to wait before the
   * next attempt; the engine never calls `setTimeout` itself.
   */
  readonly backoff?: (attempt: number) => number;
  /** Injected so a test's output does not depend on when it ran. */
  readonly now?: () => Instant;
}

export interface TailResult {
  readonly observed: number;
  readonly removed: number;
  readonly cursor: string | null;
  readonly hasMore: boolean;
  /**
   * The provider rejected our cursor and we started again from scratch.
   * Expected after a long offline period; alarming if it happens every pass.
   */
  readonly resynchronised: boolean;
}

export interface BackfillResult {
  readonly fetched: number;
  readonly complete: boolean;
}

export interface PushResult {
  readonly settled: number;
  readonly rejected: number;
  /**
   * Intents whose fate the provider never told us — the request that may have
   * succeeded server-side. Not a failure count: these are resolved on a later
   * pass by re-sending under the same idempotency key.
   */
  readonly unknown: number;
  /** Left pending because the provider was unreachable. Safe to retry. */
  readonly deferred: number;
}

export interface SettleResult {
  readonly rounds: number;
  /** False when `maxRounds` was hit with work still outstanding. */
  readonly quiescent: boolean;
}

export interface SyncEngine {
  readonly accountId: AccountId;

  /**
   * Record a local mutation.
   *
   * Appends to the intent log, applies optimistically to local state, and
   * returns. It does not talk to the provider — that is `pushOnce`. A user who
   * archives a message offline gets the same result as one who is online, and
   * the difference is only how long the intent stays pending.
   */
  record(op: IntentOp): Promise<Intent>;

  /** One pass of the live tail. Never blocked by backfill. */
  tailOnce(options?: Cancellable): Promise<TailResult>;

  /** One page of historical backfill. Never blocks the tail. */
  backfillOnce(options?: Cancellable): Promise<BackfillResult>;

  /** Push pending intents to the provider and record what came back. */
  pushOnce(options?: Cancellable): Promise<PushResult>;

  /**
   * Push and tail until nothing more changes.
   *
   * The convergence entry point: after a fault storm, calling this with faults
   * cleared must leave local state equal to server state.
   */
  settle(options?: { maxRounds?: number } & Cancellable): Promise<SettleResult>;

  status(): SyncStatus;
}
