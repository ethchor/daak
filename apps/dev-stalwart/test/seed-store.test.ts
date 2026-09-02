import { createSearcher } from "@daak/search";
import { describe, expect, it } from "vitest";
import { type Population, SIZES } from "../src/population.js";
import { SEED_ACCOUNT, seedMailboxId, seedStore } from "../src/seed-store.js";

/**
 * Small, because these are correctness tests.
 *
 * The seeded mailbox that measures anything is built by `bench.ts` at a size
 * CI cannot afford. What is asserted here is that the thing being measured is
 * a real mailbox: real events, real parses, real threads.
 */
const small: Population = { ...SIZES["1k"], messages: 400 };

describe("seeding", () => {
  it("puts every message in the store, through the event log", async () => {
    const result = await seedStore({ population: small, batchSize: 150 });
    // Generated messages plus the fixture corpus, which rides along once.
    expect(result.messages).toBeGreaterThanOrEqual(small.messages);
    expect(result.store.events.all(SEED_ACCOUNT).length).toBeGreaterThan(small.messages);
    result.store.close();
  });

  it("rebuilds to exactly the same projections", async () => {
    // The store's central invariant, asserted against a mailbox big enough to
    // have threads that actually merge. A rebuild that reshapes a conversation
    // is a bug a user can see.
    const { store } = await seedStore({ population: small, batchSize: 150 });
    const before = store.snapshot(SEED_ACCOUNT);
    await store.rebuild(SEED_ACCOUNT);
    expect(store.snapshot(SEED_ACCOUNT)).toEqual(before);
    store.close();
  });

  it("creates the mailboxes and files messages into them", async () => {
    const { store } = await seedStore({ population: small, batchSize: 400 });
    const mailboxes = store.listMailboxes(SEED_ACCOUNT);
    expect(mailboxes.map((mailbox) => mailbox.name)).toEqual([
      "Inbox",
      "Archive",
      "Sent",
      "Junk",
      "Trash",
    ]);
    const inInbox = store.queryMessages({
      accountId: SEED_ACCOUNT,
      mailboxId: seedMailboxId("Inbox"),
      limit: 10,
    });
    expect(inInbox.length).toBe(10);
    store.close();
  });

  it("threads the mail rather than leaving every message alone", async () => {
    const { store } = await seedStore({ population: small, batchSize: 400 });
    const threads = new Set(
      store.queryMessages({ accountId: SEED_ACCOUNT, limit: 400 }).map((m) => m.threadId),
    );
    // With a reply rate over half, threads must be materially fewer than
    // messages — otherwise the References chains are not being followed.
    expect(threads.size).toBeLessThan(300);
    store.close();
  });

  it("builds a full-text index that finds the mail it indexed", async () => {
    const { store } = await seedStore({ population: small, batchSize: 400 });
    const searcher = createSearcher(store);
    // `meeting` is in the common core of the vocabulary, so a mailbox of this
    // size is overwhelmingly likely to contain it — and this is the first time
    // in the repo that search has run over a corpus it did not hand-write.
    const hits = searcher.search("meeting", {
      accountId: SEED_ACCOUNT,
      now: small.endsAt as never,
      limit: 20,
    });
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) expect(store.getMessage(hit.messageId)).not.toBeNull();
    store.close();
  });

  it("answers a structured query with no text at all", async () => {
    const { store } = await seedStore({ population: small, batchSize: 400 });
    const searcher = createSearcher(store);
    const hits = searcher.search("in:inbox is:unread", {
      accountId: SEED_ACCOUNT,
      now: small.endsAt as never,
      limit: 20,
    });
    for (const hit of hits) {
      const message = store.getMessage(hit.messageId);
      expect(message?.keywords).not.toContain("$seen");
    }
    store.close();
  });

  it("is reproducible: two seeds of the same population project identically", async () => {
    const first = await seedStore({ population: small, batchSize: 400 });
    const second = await seedStore({ population: small, batchSize: 400 });
    expect(second.store.snapshot(SEED_ACCOUNT)).toEqual(first.store.snapshot(SEED_ACCOUNT));
    first.store.close();
    second.store.close();
  });

  it("reports where the time went", async () => {
    const { store, timings } = await seedStore({ population: small, batchSize: 400 });
    expect(timings.total).toBeGreaterThanOrEqual(0);
    expect(timings.project).toBeGreaterThanOrEqual(0);
    expect(timings.index).toBeGreaterThanOrEqual(0);
    store.close();
  });
});
