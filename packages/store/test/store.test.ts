import { blobIdFromDigest, mailboxId, messageId } from "@daak/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { LATEST_VERSION, MIGRATIONS } from "../src/migrations.js";
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

const stores: Store[] = [];
const open = (projectors = realProjectors) => {
  const store = makeStore(projectors);
  stores.push(store);
  return store;
};
afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
});

describe("migrations", () => {
  it("runs forward to the latest version", () => {
    expect(open().schemaVersion()).toBe(LATEST_VERSION);
  });

  it("is idempotent", () => {
    const store = open();
    expect(store.migrate()).toBe(LATEST_VERSION);
    expect(store.migrate()).toBe(LATEST_VERSION);
  });

  it("runs back down and forward again", () => {
    // A migration without a working `down` is one nobody can undo in a hurry.
    const store = open();
    expect(store.rollback(0)).toBe(0);
    expect(
      store.driver.prepare("select name from sqlite_master where name = 'messages'").get(),
    ).toBeUndefined();
    expect(store.migrate()).toBe(LATEST_VERSION);
  });

  it("refuses a database written by a newer build", () => {
    const store = open();
    store.driver.exec(`pragma user_version = ${LATEST_VERSION + 5}`);
    // Running old code against a newer schema corrupts quietly. Refusing is the
    // only safe answer.
    expect(() => store.migrate()).toThrowError(/schema/);
  });

  it("gives every migration a down step", () => {
    for (const migration of MIGRATIONS) {
      expect(`${migration.version}:${migration.down.trim().length > 0}`).toBe(
        `${migration.version}:true`,
      );
    }
  });
});

describe("blobs", () => {
  it("addresses by content, not by name", async () => {
    const store = open();
    const bytes = new TextEncoder().encode("hello");
    const first = await store.blobs.put(bytes);
    const second = await store.blobs.put(new TextEncoder().encode("hello"));

    expect(first.id).toBe(second.id);
    expect(first.id).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("stores identical bytes once", async () => {
    const store = open();
    const bytes = new TextEncoder().encode("shared across accounts");
    await store.blobs.put(bytes);
    await store.blobs.put(bytes);
    const count = store.driver.prepare("select count(*) as n from blobs").get();
    expect(count?.n).toBe(1);
  });

  it("round-trips bytes exactly, including a bare LF body", async () => {
    const store = open();
    const bytes = new Uint8Array([0x00, 0x0a, 0xff, 0x0d, 0x0a, 0x80]);
    const { id } = await store.blobs.put(bytes);
    expect(Array.from(await store.blobs.get(id))).toEqual(Array.from(bytes));
  });

  it("reports a missing blob as not found rather than returning nothing", async () => {
    const store = open();
    await expect(store.blobs.get(blobIdFromDigest("a".repeat(64)))).rejects.toMatchObject({
      kind: "permanent",
      code: "resource.not_found",
    });
  });

  it("will not delete a blob a message still points at", async () => {
    const store = open();
    await observeMessage(store, { id: "m1" });
    const message = store.getMessage(messageId("m1"));
    expect(message).not.toBeNull();
    // The foreign key is the backstop for a garbage collector with a bug.
    await expect(store.blobs.delete(message?.blobId as never)).rejects.toThrow();
  });
});

describe("event log", () => {
  it("assigns monotonic sequence numbers the caller cannot choose", async () => {
    const store = open();
    await observeMessage(store, { id: "m1" });
    const events = store.events.all(ACCOUNT);
    const seqs = events.map((event) => event.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("refuses an event that could not be replayed", () => {
    const store = open();
    expect(() =>
      store.events.append({
        accountId: ACCOUNT,
        source: "remote",
        // An event whose payload cannot be parsed back breaks rebuild silently,
        // months later. Reject it at write time instead.
        payload: { type: "message.vibed" } as never,
      }),
    ).toThrow();
  });

  it("reads back only what came after a sequence number", async () => {
    const store = open();
    await observeMessage(store, { id: "m1" });
    const half = store.events.latestSeq(ACCOUNT);
    await observeMessage(store, { id: "m2", minute: 1 });

    const later = store.events.since(ACCOUNT, half);
    expect(later.length).toBeGreaterThan(0);
    expect(later.every((event) => event.seq > half)).toBe(true);
  });
});

describe("projections and queries", () => {
  it("derives message fields from the bytes", async () => {
    const store = open();
    await observeMessage(store, { id: "m1", subject: "Quarterly numbers" });

    const message = store.getMessage(messageId("m1"));
    expect(message?.subject).toBe("Quarterly numbers");
    expect(message?.preview).toBe("Body text.");
    expect(message?.from[0]?.address).toBe("asha@example.org");
    expect(message?.messageIdHeader).toEqual(["m1@example.org"]);
  });

  it("keeps keywords as a sorted set", async () => {
    const store = open();
    await observeMessage(store, { id: "m1", keywords: ["$seen", "$flagged", "$seen"] });
    expect(store.getMessage(messageId("m1"))?.keywords).toEqual(["$flagged", "$seen"]);
  });

  it("replaces a keyword set rather than merging into it", async () => {
    const store = open();
    const id = await observeMessage(store, { id: "m1", keywords: ["$seen", "$flagged"] });
    const events = store.events.appendMany([
      {
        accountId: ACCOUNT,
        source: "local",
        at: at(5),
        payload: { type: "message.keywords.set", messageId: id, keywords: ["$seen"] },
      },
    ]);
    await store.projector.apply(events, (blob) => store.blobs.get(blob as never));

    // Events carry the complete set after the change, not a delta.
    expect(store.getMessage(id)?.keywords).toEqual(["$seen"]);
  });

  it("filters by mailbox, keyword and absence of a keyword", async () => {
    const store = open();
    await observeMessage(store, { id: "m1", minute: 0, keywords: ["$seen"], mailboxes: [INBOX] });
    await observeMessage(store, { id: "m2", minute: 1, keywords: [], mailboxes: [ARCHIVE] });

    expect(store.queryMessages({ accountId: ACCOUNT, mailboxId: INBOX }).map((m) => m.id)).toEqual([
      "m1",
    ]);
    expect(
      store.queryMessages({ accountId: ACCOUNT, lacksKeyword: "$seen" }).map((m) => m.id),
    ).toEqual(["m2"]);
    expect(
      store.queryMessages({ accountId: ACCOUNT, hasKeyword: "$seen" }).map((m) => m.id),
    ).toEqual(["m1"]);
  });

  it("returns newest first and pages without skipping or repeating", async () => {
    const store = open();
    for (let i = 0; i < 5; i++) await observeMessage(store, { id: `m${i}`, minute: i });

    const first = store.queryMessages({ accountId: ACCOUNT, limit: 2 });
    expect(first.map((m) => m.id)).toEqual(["m4", "m3"]);

    const second = store.queryMessages({
      accountId: ACCOUNT,
      limit: 10,
      before: first[first.length - 1]?.receivedAt,
    });
    const seen = [...first, ...second].map((m) => m.id);
    expect(new Set(seen).size).toBe(5);
  });

  it("groups a reply with its parent and exposes the thread", async () => {
    const store = open();
    await observeMessage(store, { id: "root", subject: "Quarterly numbers", minute: 0 });
    await observeMessage(store, { id: "reply", subject: "Re: Quarterly numbers", minute: 1 });

    const root = store.getMessage(messageId("root"));
    const reply = store.getMessage(messageId("reply"));
    expect(reply?.threadId).toBe(root?.threadId);

    const thread = store.getThread(root?.threadId as never);
    expect(thread?.messageIds).toEqual(["root", "reply"]);
    expect(thread?.subject).toBe("Quarterly numbers");
  });

  it("removes a message and its set rows together", async () => {
    const store = open();
    const id = await observeMessage(store, { id: "m1", keywords: ["$seen"] });
    const events = store.events.appendMany([
      {
        accountId: ACCOUNT,
        source: "remote",
        at: at(9),
        payload: { type: "message.removed", messageId: id },
      },
    ]);
    await store.projector.apply(events, (blob) => store.blobs.get(blob as never));

    expect(store.getMessage(id)).toBeNull();
    const orphans = store.driver.prepare("select count(*) as n from message_keywords").get();
    expect(orphans?.n).toBe(0);
  });

  it("ignores a set operation for a message that is not here", async () => {
    // Replay has to be total. A flag change that arrives after a removal is a
    // no-op, not a crash that makes the account unrebuildable.
    const store = open();
    const events = store.events.appendMany([
      {
        accountId: ACCOUNT,
        source: "remote",
        at: at(1),
        payload: {
          type: "message.keywords.set",
          messageId: messageId("never-seen"),
          keywords: ["$seen"],
        },
      },
    ]);
    await expect(
      store.projector.apply(events, (blob) => store.blobs.get(blob as never)),
    ).resolves.toBeUndefined();
  });

  it("upserts and removes mailboxes", async () => {
    const store = open();
    const events = store.events.appendMany([
      {
        accountId: ACCOUNT,
        source: "remote",
        at: at(0),
        payload: {
          type: "mailbox.upserted",
          mailbox: {
            id: mailboxId("mb1"),
            accountId: ACCOUNT,
            providerId: "INBOX",
            name: "Inbox",
            parentId: null,
            role: "inbox",
            sortOrder: 0,
          },
        },
      },
    ]);
    await store.projector.apply(events, (blob) => store.blobs.get(blob as never));

    expect(store.listMailboxes(ACCOUNT).map((m) => m.name)).toEqual(["Inbox"]);

    const removal = store.events.appendMany([
      {
        accountId: ACCOUNT,
        source: "remote",
        at: at(1),
        payload: { type: "mailbox.removed", mailboxId: mailboxId("mb1") },
      },
    ]);
    await store.projector.apply(removal, (blob) => store.blobs.get(blob as never));
    expect(store.listMailboxes(ACCOUNT)).toEqual([]);
  });

  it("records a sync cursor from the log", async () => {
    const store = open();
    const events = store.events.appendMany([
      {
        accountId: ACCOUNT,
        source: "remote",
        at: at(0),
        payload: { type: "sync.cursor.advanced", collection: "message", cursor: "s-42" },
      },
    ]);
    await store.projector.apply(events, (blob) => store.blobs.get(blob as never));
    expect(store.snapshot(ACCOUNT).cursors).toEqual([JSON.stringify(["message", "s-42"])]);
  });
});

describe("credentials", () => {
  it("has nowhere to put a secret", () => {
    const store = open();
    const columns = store.driver
      .prepare("select name from pragma_table_info('accounts')")
      .all()
      .map((row) => String(row.name));
    // A dump of this file must not be enough to read someone's mail.
    expect(columns).toContain("secret_ref");
    expect(columns.some((name) => /password|token|secret$|credential/.test(name))).toBe(false);
  });
});
