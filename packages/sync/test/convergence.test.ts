import type { FaultKind, ProviderOp } from "@daak/adapter-mock";
import type { IntentOp } from "@daak/contracts";
import { mailboxId, messageId } from "@daak/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { localMailboxId, localMessageId } from "../src/ids.js";
import { ACCOUNT, localSnapshot, makeRig, serverSnapshot } from "./harness.js";

/**
 * The property this package exists to satisfy.
 *
 * > For any sequence of local mutations and any injected fault pattern, local
 * > state converges to server state after reconnect.
 *
 * Written before the engine was, per the build plan's discipline for this lane.
 * It is the test that catches the class of bug agents produce here: code that
 * handles the happy path and one error case, and silently mishandles the
 * ambiguous one — the request that timed out after it had already succeeded.
 *
 * Everything below is deterministic. The mock is seeded, the engine takes no
 * timers, and clocks are injected, so a failure reproduces from its counter-
 * example alone.
 */

const MAILBOXES = ["INBOX", "ARCHIVE", "TRASH"] as const;
const KEYWORDS = ["$seen", "$flagged", "work"] as const;

/** Faults a real server actually produces, including the one that matters. */
const FAULTS: readonly FaultKind[] = [
  "disconnect",
  "apply-then-fail",
  "duplicate-events",
  "reorder-batch",
  "expire-cursor",
  "rate-limit",
  "stale-read",
  "short-batch",
];

const OPS: readonly ProviderOp[] = ["changes", "fetchMetadata", "fetchRaw", "apply", "backfill"];

const arbMutation = fc.oneof(
  fc.record({
    kind: fc.constant("keywords" as const),
    target: fc.integer({ min: 1, max: 4 }),
    add: fc.uniqueArray(fc.constantFrom(...KEYWORDS), { maxLength: 2 }),
    remove: fc.uniqueArray(fc.constantFrom(...KEYWORDS), { maxLength: 2 }),
  }),
  fc.record({
    kind: fc.constant("mailboxes" as const),
    target: fc.integer({ min: 1, max: 4 }),
    add: fc.uniqueArray(fc.constantFrom(...MAILBOXES), { maxLength: 2 }),
    remove: fc.uniqueArray(fc.constantFrom(...MAILBOXES), { maxLength: 2 }),
  }),
  fc.record({
    kind: fc.constant("destroy" as const),
    target: fc.integer({ min: 1, max: 4 }),
  }),
);

const arbFault = fc.record({
  op: fc.constantFrom(...OPS),
  kind: fc.constantFrom(...FAULTS),
  times: fc.integer({ min: 1, max: 3 }),
});

const toOp = (mutation: {
  kind: string;
  target: number;
  add?: string[];
  remove?: string[];
}): IntentOp => {
  const target = messageId(localMessageId(ACCOUNT, `P${mutation.target}`));
  if (mutation.kind === "keywords") {
    return {
      op: "keywords.change",
      messageIds: [target],
      add: mutation.add ?? [],
      remove: mutation.remove ?? [],
    };
  }
  if (mutation.kind === "mailboxes") {
    return {
      op: "mailboxes.change",
      messageIds: [target],
      add: (mutation.add ?? []).map((m) => mailboxId(localMailboxId(ACCOUNT, m))),
      remove: (mutation.remove ?? []).map((m) => mailboxId(localMailboxId(ACCOUNT, m))),
    };
  }
  return { op: "message.destroy", messageIds: [target] };
};

describe("convergence", () => {
  it("reaches server state after any mutation sequence and any fault pattern", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbMutation, { maxLength: 8 }),
        fc.array(arbFault, { maxLength: 6 }),
        fc.integer({ min: 1, max: 1000 }),
        async (mutations, faults, seed) => {
          const rig = makeRig({ seed, messages: 4 });
          try {
            // Learn about the mailbox and the four messages before any chaos.
            await rig.engine.settle();

            for (const fault of faults) {
              rig.provider.faults.inject(fault);
            }

            for (const mutation of mutations) {
              await rig.engine.record(toOp(mutation));
              // Push under fault: some land, some are rejected, some come back
              // as `unknown`, and some never leave the machine.
              await rig.engine.settle({ maxRounds: 3 }).catch(() => undefined);
            }

            // The network comes back.
            rig.provider.faults.clear();
            const settled = await rig.engine.settle({ maxRounds: 40 });

            expect(settled.quiescent).toBe(true);
            expect(localSnapshot(rig.store)).toEqual(serverSnapshot(rig.provider));
          } finally {
            rig.close();
          }
        },
      ),
      { numRuns: 200 },
    );
  }, 120_000);

  it("never applies an ambiguous mutation twice", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 500 }), async (seed) => {
        const rig = makeRig({ seed, messages: 2 });
        try {
          await rig.engine.settle();

          // The mutation lands server-side, then the response is lost. An
          // engine that resends without the idempotency key applies it twice;
          // one that rolls back diverges from the server permanently.
          rig.provider.faults.once("apply", "apply-then-fail");
          await rig.engine.record({
            op: "keywords.change",
            messageIds: [messageId(localMessageId(ACCOUNT, "P1"))],
            add: ["$seen"],
            remove: [],
          });
          await rig.engine.settle({ maxRounds: 20 });

          expect(rig.provider.server.snapshot().P1?.keywords).toEqual(["$seen"]);
          expect(localSnapshot(rig.store)).toEqual(serverSnapshot(rig.provider));
        } finally {
          rig.close();
        }
      }),
      { numRuns: 25 },
    );
  }, 60_000);

  it("accounts for every intent it was given", async () => {
    const rig = makeRig({ seed: "accounting", messages: 3 });
    try {
      await rig.engine.settle();
      rig.provider.faults.inject({ op: "apply", kind: "apply-then-fail", times: 2 });

      for (let i = 1; i <= 3; i++) {
        await rig.engine.record({
          op: "keywords.change",
          messageIds: [messageId(localMessageId(ACCOUNT, `P${i}`))],
          add: ["$seen"],
          remove: [],
        });
      }
      rig.provider.faults.clear();
      await rig.engine.settle({ maxRounds: 30 });

      // No intent may be silently dropped: an unsent change is a user's lost
      // work, and one stuck forever is a queue that never drains.
      const states = rig.store.driver
        .prepare("select state, count(*) as n from intents group by state")
        .all()
        .map((row) => `${row["state"]}=${row["n"]}`)
        .sort();
      expect(states).toEqual(["settled=3"]);
      expect(rig.engine.status().pendingIntents).toBe(0);
    } finally {
      rig.close();
    }
  });

  it("is idempotent: settling twice changes nothing", async () => {
    const rig = makeRig({ seed: "idempotent", messages: 3 });
    try {
      await rig.engine.settle();
      await rig.engine.record({
        op: "mailboxes.change",
        messageIds: [messageId(localMessageId(ACCOUNT, "P2"))],
        add: [mailboxId(localMailboxId(ACCOUNT, "ARCHIVE"))],
        remove: [mailboxId(localMailboxId(ACCOUNT, "INBOX"))],
      });
      await rig.engine.settle();

      const once = localSnapshot(rig.store);
      const serverOnce = serverSnapshot(rig.provider);
      await rig.engine.settle();

      expect(localSnapshot(rig.store)).toEqual(once);
      expect(serverSnapshot(rig.provider)).toEqual(serverOnce);
    } finally {
      rig.close();
    }
  });

  it("recovers from a cursor the provider has expired", async () => {
    const rig = makeRig({ seed: "expiry", messages: 3 });
    try {
      await rig.engine.settle();
      rig.provider.server.addMessage({ raw: "Subject: later\r\n\r\nx\r\n", providerId: "P9" });

      // A long offline period ends with the server refusing our state string.
      // The only correct answer is to resynchronise, not to give up.
      rig.provider.faults.once("changes", "expire-cursor");
      const result = await rig.engine.tailOnce();
      expect(result.resynchronised).toBe(true);

      await rig.engine.settle();
      expect(localSnapshot(rig.store)).toEqual(serverSnapshot(rig.provider));
    } finally {
      rig.close();
    }
  });

  it("survives duplicated and reordered change batches", async () => {
    const rig = makeRig({ seed: "reorder", messages: 4 });
    try {
      rig.provider.faults.inject({ op: "changes", kind: "duplicate-events", times: 3 });
      rig.provider.faults.inject({ op: "changes", kind: "reorder-batch", times: 3 });

      await rig.engine.settle({ maxRounds: 30 });
      rig.provider.faults.clear();
      await rig.engine.settle({ maxRounds: 30 });

      // A duplicate must not create a second message, and reordering must not
      // leave one behind.
      expect(rig.store.countMessages(ACCOUNT)).toBe(4);
      expect(localSnapshot(rig.store)).toEqual(serverSnapshot(rig.provider));
    } finally {
      rig.close();
    }
  });

  it("keeps a rejected mutation from sticking to local state", async () => {
    const rig = makeRig({ seed: "rejection", messages: 2 });
    try {
      await rig.engine.settle();

      // The provider refuses the change. Optimistic local state has to be
      // walked back to what the server actually holds, not left as the user's
      // wish.
      await rig.engine.record({
        op: "mailboxes.change",
        messageIds: [messageId(localMessageId(ACCOUNT, "P1"))],
        add: [mailboxId(localMailboxId(ACCOUNT, "NOT-A-REAL-MAILBOX"))],
        remove: [],
      });
      await rig.engine.settle({ maxRounds: 20 });

      expect(localSnapshot(rig.store)).toEqual(serverSnapshot(rig.provider));
    } finally {
      rig.close();
    }
  });

  it("lets the tail make progress while backfill is still running", async () => {
    const rig = makeRig({ seed: "lanes", messages: 9 });
    try {
      // Backfill walks history a page at a time. New mail must not have to wait
      // for it to finish — a mailbox that goes quiet for an hour during the
      // first sync is a client people close.
      const first = await rig.engine.backfillOnce();
      expect(first.complete).toBe(false);

      rig.provider.server.addMessage({ raw: "Subject: new\r\n\r\nx\r\n", providerId: "PNEW" });
      const tail = await rig.engine.tailOnce();
      expect(tail.observed).toBeGreaterThan(0);

      await rig.engine.settle({ maxRounds: 40 });
      expect(rig.store.countMessages(ACCOUNT)).toBe(10);
    } finally {
      rig.close();
    }
  });
});
