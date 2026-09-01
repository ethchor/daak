import type { Rng } from "./rng.js";

/**
 * The faults a real mail server actually produces.
 *
 * The list is short on purpose: each of these corresponds to a bug class the
 * sync engine must survive, and the important one is `apply-then-fail`. If the
 * mock cannot apply a mutation and *then* fail the response, the engine can
 * never be tested against the ambiguous timeout — the request that succeeded
 * server-side and never told the client. That is the bug that corrupts
 * mailboxes on the third reconnect, and it is invisible to every happy-path
 * test ever written.
 */
export const FAULT_KINDS = [
  /** Connection dies before the server does anything. Safe to retry. */
  "disconnect",
  /** The mutation lands, then the response is lost. NOT safe to blind-retry. */
  "apply-then-fail",
  /** The same change reported twice in one batch. */
  "duplicate-events",
  /** A batch arrives out of order. */
  "reorder-batch",
  /** The cursor is too old; the server demands a resynchronise. */
  "expire-cursor",
  /** 429 with a Retry-After. */
  "rate-limit",
  /** A read that reflects state from before the last write. */
  "stale-read",
  /** The server returns fewer items than asked for, with no explanation. */
  "short-batch",
] as const;
export type FaultKind = (typeof FAULT_KINDS)[number];

export type ProviderOp =
  | "listMailboxes"
  | "changes"
  | "backfill"
  | "fetchMetadata"
  | "fetchRaw"
  | "uploadBlob"
  | "apply"
  | "submit";

export interface FaultRule {
  /** Which call to affect. `"*"` matches every operation. */
  readonly op: ProviderOp | "*";
  readonly kind: FaultKind;
  /** Fire at most this many times. Omit for unlimited. */
  readonly times?: number;
  /** Fire with this probability, drawn from the seeded rng. Default 1. */
  readonly probability?: number;
}

export interface FaultController {
  /** Queue a rule. Rules are consulted in insertion order; first match wins. */
  inject(rule: FaultRule): void;
  /** Convenience for a single occurrence. */
  once(op: ProviderOp | "*", kind: FaultKind): void;
  clear(): void;
  /** What has fired so far, in order. Assert against this in tests. */
  readonly fired: readonly { op: ProviderOp; kind: FaultKind }[];
}

export interface FaultEngine extends FaultController {
  /** Called by the provider before each operation. Consumes a matching rule. */
  take(op: ProviderOp): FaultKind | null;
}

export const createFaultEngine = (rng: Rng): FaultEngine => {
  const rules: { rule: FaultRule; remaining: number }[] = [];
  const fired: { op: ProviderOp; kind: FaultKind }[] = [];

  return {
    fired,
    inject(rule) {
      rules.push({ rule, remaining: rule.times ?? Number.POSITIVE_INFINITY });
    },
    once(op, kind) {
      rules.push({ rule: { op, kind, times: 1 }, remaining: 1 });
    },
    clear() {
      rules.length = 0;
      fired.length = 0;
    },
    take(op) {
      for (let i = 0; i < rules.length; i++) {
        const entry = rules[i];
        if (entry === undefined || entry.remaining <= 0) continue;
        if (entry.rule.op !== "*" && entry.rule.op !== op) continue;
        // The probability draw happens only for a rule that already matched,
        // so an unrelated call cannot consume randomness and shift the run.
        if (!rng.bool(entry.rule.probability ?? 1)) continue;

        entry.remaining -= 1;
        fired.push({ op, kind: entry.rule.kind });
        return entry.rule.kind;
      }
      return null;
    },
  };
};
