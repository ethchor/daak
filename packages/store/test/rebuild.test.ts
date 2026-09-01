import type { EventPayload } from "@daak/contracts";
import { messageId } from "@daak/contracts";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import type { Store } from "../src/store.js";
import {
  ACCOUNT,
  ARCHIVE,
  at,
  INBOX,
  makeStore,
  observeMessage,
  realProjectors,
} from "./harness.js";

/**
 * ARCHITECTURE.md invariant 2, as a test rather than a claim.
 *
 * "Every table other than blobs and events must be rebuildable from those two."
 * The way to know is to drop every derived row, replay the log, and compare.
 * Anything that survives only because it was written once and never re-derived
 * shows up here as a difference.
 */
const stores: Store[] = [];
const open = (projectors = realProjectors) => {
  const store = makeStore(projectors);
  stores.push(store);
  return store;
};

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
});

describe("rebuild", () => {
  it("reproduces every projection exactly", async () => {
    const store = open();
    await observeMessage(store, { id: "m1", minute: 0, keywords: ["$seen"] });
    await observeMessage(store, {
      id: "m2",
      subject: "Re: Quarterly numbers",
      minute: 1,
      keywords: ["$flagged"],
      mailboxes: [INBOX, ARCHIVE],
    });

    const before = store.snapshot(ACCOUNT);
    expect(before.messages).toHaveLength(2);

    await store.rebuild(ACCOUNT);

    expect(store.snapshot(ACCOUNT)).toEqual(before);
  });

  it("leaves the sources of truth untouched", async () => {
    const store = open();
    await observeMessage(store, { id: "m1" });
    const eventsBefore = store.events.count(ACCOUNT);
    const blobExists = await store.blobs.has((await store.blobs.put(new Uint8Array([1, 2, 3]))).id);

    await store.rebuild(ACCOUNT);

    // A rebuild that appends to the log or drops a blob is not a rebuild.
    expect(store.events.count(ACCOUNT)).toBe(eventsBefore);
    expect(blobExists).toBe(true);
  });

  it("is idempotent", async () => {
    const store = open();
    await observeMessage(store, { id: "m1", keywords: ["$seen"] });

    await store.rebuild(ACCOUNT);
    const once = store.snapshot(ACCOUNT);
    await store.rebuild(ACCOUNT);

    expect(store.snapshot(ACCOUNT)).toEqual(once);
  });

  it("recovers a projection that was corrupted underneath it", async () => {
    const store = open();
    await observeMessage(store, { id: "m1", keywords: ["$seen"] });
    const before = store.snapshot(ACCOUNT);

    // Simulate the thing a rebuild exists for: a derived table that has drifted.
    store.driver.exec("update messages set subject = 'wrong', preview = 'wrong'");
    store.driver.exec("delete from message_keywords");
    expect(store.snapshot(ACCOUNT)).not.toEqual(before);

    await store.rebuild(ACCOUNT);
    expect(store.snapshot(ACCOUNT)).toEqual(before);
  });

  it("picks up an improved parser without re-fetching anything", async () => {
    // The practical payoff: a fix in @daak/mime reaches messages already
    // stored, because the bytes are canonical and everything else is derived.
    const store = open({
      ...realProjectors,
      async resolveMessage(raw) {
        const fields = await realProjectors.resolveMessage(raw);
        return { ...fields, preview: "OLD PARSER" };
      },
    });
    await observeMessage(store, { id: "m1" });
    expect(store.getMessage(messageId("m1"))?.preview).toBe("OLD PARSER");

    const improved = open(realProjectors);
    // Same log, same blobs, better projector.
    for (const event of store.events.all(ACCOUNT)) {
      improved.events.append({
        accountId: ACCOUNT,
        source: event.source,
        payload: event.payload,
        at: event.at,
      });
    }
    await improved.blobs.put(
      await store.blobs.get(store.getMessage(messageId("m1"))?.blobId as never),
    );
    await improved.rebuild(ACCOUNT);

    expect(improved.getMessage(messageId("m1"))?.preview).toBe("Body text.");
  });

  it("keeps threads consistent across a rebuild", async () => {
    const store = open();
    await observeMessage(store, { id: "root", subject: "Quarterly numbers", minute: 0 });
    await observeMessage(store, { id: "reply", subject: "Re: Quarterly numbers", minute: 1 });

    const threadsBefore = store.snapshot(ACCOUNT).threads;
    await store.rebuild(ACCOUNT);
    expect(store.snapshot(ACCOUNT).threads).toEqual(threadsBefore);
  });
});

/**
 * The same invariant, over sequences nobody wrote a test for.
 *
 * Keyword and mailbox events are the interesting ones: they are absolute sets
 * rather than deltas, so replaying them in order must converge on the same state
 * however many times a message is touched.
 */
const arbEvents = fc.array(
  fc.oneof(
    fc.record({
      kind: fc.constant("keywords" as const),
      target: fc.integer({ min: 0, max: 3 }),
      keywords: fc.uniqueArray(fc.constantFrom("$seen", "$flagged", "$draft", "work"), {
        maxLength: 4,
      }),
    }),
    fc.record({
      kind: fc.constant("mailboxes" as const),
      target: fc.integer({ min: 0, max: 3 }),
      mailboxes: fc.uniqueArray(fc.constantFrom(INBOX, ARCHIVE), { maxLength: 2 }),
    }),
    fc.record({
      kind: fc.constant("remove" as const),
      target: fc.integer({ min: 0, max: 3 }),
    }),
  ),
  { maxLength: 20 },
);

describe("rebuild properties", () => {
  it("converges for any sequence of set operations", async () => {
    await fc.assert(
      fc.asyncProperty(arbEvents, async (operations) => {
        const store = makeStore(realProjectors);
        try {
          store.migrate();
          const ids: string[] = [];
          for (let i = 0; i < 4; i++) {
            await observeMessage(store, { id: `m${i}`, minute: i });
            ids.push(`m${i}`);
          }

          const toPayload = (operation: (typeof operations)[number]): EventPayload => {
            const target = messageId(ids[operation.target] ?? "m0");
            if (operation.kind === "keywords") {
              return {
                type: "message.keywords.set",
                messageId: target,
                keywords: operation.keywords,
              };
            }
            if (operation.kind === "mailboxes") {
              return {
                type: "message.mailboxes.set",
                messageId: target,
                mailboxIds: operation.mailboxes as never,
              };
            }
            return { type: "message.removed", messageId: target };
          };
          const payloads: EventPayload[] = operations.map(toPayload);

          const events = store.events.appendMany(
            payloads.map((payload, index) => ({
              accountId: ACCOUNT,
              source: "local" as const,
              payload,
              at: at(100 + index),
            })),
          );
          await store.projector.apply(events, (blob) => store.blobs.get(blob as never));

          const before = store.snapshot(ACCOUNT);
          await store.rebuild(ACCOUNT);
          expect(store.snapshot(ACCOUNT)).toEqual(before);
        } finally {
          store.close();
        }
      }),
      { numRuns: 60 },
    );
  });
});
