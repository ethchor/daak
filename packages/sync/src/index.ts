/**
 * @daak/sync — cursors, the intent log, and reconciliation.
 *
 * The deep-review lane. Its properties were specified before its logic; see
 * test/convergence.test.ts and CLAUDE.md.
 */
export { createSyncEngine } from "./engine.js";
export type {
  BackfillResult,
  PushResult,
  SettleResult,
  SyncEngine,
  SyncEngineOptions,
  TailResult,
} from "./types.js";
export { localMailboxId, localMessageId } from "./ids.js";
