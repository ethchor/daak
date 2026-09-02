import {
  type AccountId,
  accountId,
  type EventPayload,
  type Instant,
  mailboxId,
  messageId,
} from "@daak/contracts";
import { parseMessage } from "@daak/mime";
import {
  createNodeDriver,
  type MessageFields,
  openStore,
  type Projectors,
  type Store,
} from "@daak/store";
import { threadMessages } from "@daak/threading";
import { afterEach, describe, expect, it } from "vitest";
import { createSearchIndex, type SearchIndex } from "../src/index-writer.js";
import { createSearcher, type Searcher } from "../src/search.js";

const ACCOUNT: AccountId = accountId("acct");
const INBOX = mailboxId("mb-inbox");
const ARCHIVE = mailboxId("mb-archive");
const NOW = "2026-09-01T00:00:00.000Z" as Instant;

const projectors: Projectors = {
  async resolveMessage(raw): Promise<MessageFields> {
    const parsed = await parseMessage(raw);
    return { ...parsed.envelope, hasAttachment: parsed.hasAttachment, preview: parsed.preview };
  },
  threadMessages: (input) => threadMessages(input),
};

interface Rig {
  store: Store;
  index: SearchIndex;
  searcher: Searcher;
  add(input: {
    id: string;
    from?: string;
    to?: string;
    subject?: string;
    body?: string;
    daysAgo?: number;
    keywords?: string[];
    mailbox?: string;
    attachment?: boolean;
  }): Promise<void>;
  find(query: string, options?: { limit?: number; recencyWeight?: number }): string[];
  close(): void;
}

const makeRig = (): Rig => {
  const store = openStore({ driver: createNodeDriver(), projectors });
  store.migrate();
  const index = createSearchIndex(store);
  const searcher = createSearcher(store);

  return {
    store,
    index,
    searcher,
    async add(input) {
      const from = input.from ?? "Asha Menon <asha@example.org>";
      const to = input.to ?? "You <you@example.net>";
      const subject = input.subject ?? "Quarterly numbers";
      const body = input.body ?? "Nothing surprising in the figures.";
      const boundary = "b1";
      const raw = new TextEncoder().encode(
        input.attachment === true
          ? `Message-ID: <${input.id}@example.org>\r\nFrom: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n--${boundary}\r\nContent-Type: text/plain\r\n\r\n${body}\r\n\r\n--${boundary}\r\nContent-Type: application/pdf; name="report.pdf"\r\nContent-Disposition: attachment; filename="report.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0xLjQK\r\n\r\n--${boundary}--\r\n`
          : `Message-ID: <${input.id}@example.org>\r\nFrom: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=us-ascii\r\n\r\n${body}\r\n`,
      );

      const blob = await store.blobs.put(raw);
      const id = messageId(input.id);
      const receivedAt = new Date(
        Date.parse(NOW) - (input.daysAgo ?? 0) * 86_400_000,
      ).toISOString() as Instant;

      const payloads: EventPayload[] = [
        { type: "blob.stored", blobId: blob.id, size: blob.size },
        {
          type: "message.observed",
          messageId: id,
          blobId: blob.id,
          providerId: `P-${input.id}`,
          receivedAt,
        },
        { type: "message.keywords.set", messageId: id, keywords: input.keywords ?? [] },
        {
          type: "message.mailboxes.set",
          messageId: id,
          mailboxIds: [(input.mailbox ?? INBOX) as never],
        },
      ];
      const events = store.events.appendMany(
        payloads.map((payload) => ({ accountId: ACCOUNT, source: "remote" as const, payload })),
      );
      await store.projector.apply(events, (blobId) => store.blobs.get(blobId as never));

      const parsed = await parseMessage(raw);
      index.index([
        {
          messageId: id,
          accountId: ACCOUNT,
          subject: parsed.envelope.subject,
          sender: parsed.envelope.from.map((a) => `${a.name} ${a.address}`).join(" "),
          recipients: parsed.envelope.to.map((a) => `${a.name} ${a.address}`).join(" "),
          body: parsed.text ?? "",
        },
      ]);
    },
    find(query, options) {
      return searcher
        .search(query, { accountId: ACCOUNT, now: NOW, ...options })
        .map((hit) => String(hit.messageId));
    },
    close() {
      store.close();
    },
  };
};

let rig: Rig | undefined;
const open = () => {
  rig = makeRig();
  return rig;
};
afterEach(() => {
  rig?.close();
  rig = undefined;
});

const seedMailboxes = async (r: Rig) => {
  const events = r.store.events.appendMany(
    [INBOX, ARCHIVE].map((id, index) => ({
      accountId: ACCOUNT,
      source: "remote" as const,
      payload: {
        type: "mailbox.upserted" as const,
        mailbox: {
          id,
          accountId: ACCOUNT,
          providerId: String(id),
          name: index === 0 ? "Inbox" : "Archive",
          parentId: null,
          role: index === 0 ? ("inbox" as const) : ("archive" as const),
          sortOrder: index,
        },
      },
    })),
  );
  await r.store.projector.apply(events, (blobId) => r.store.blobs.get(blobId as never));
};

describe("full-text", () => {
  it("finds a message by a word in its body", async () => {
    const r = open();
    await r.add({ id: "m1", body: "The invoice is attached and overdue." });
    await r.add({ id: "m2", body: "Lunch on Thursday?" });

    expect(r.find("invoice")).toEqual(["m1"]);
  });

  it("finds by subject and by sender", async () => {
    const r = open();
    await r.add({ id: "m1", subject: "Deployment postmortem", from: "Kavya <kavya@example.org>" });
    await r.add({ id: "m2", subject: "Lunch" });

    expect(r.find("postmortem")).toEqual(["m1"]);
    expect(r.find("kavya")).toEqual(["m1"]);
  });

  it("requires every term", async () => {
    const r = open();
    await r.add({ id: "m1", body: "quarterly invoice figures" });
    await r.add({ id: "m2", body: "quarterly lunch plans" });

    expect(r.find("quarterly invoice")).toEqual(["m1"]);
  });

  it("matches a quoted phrase as a phrase", async () => {
    const r = open();
    // Distinct subjects: the default one contains both words, and the phrase
    // would match through the subject column rather than the body.
    await r.add({ id: "m1", subject: "One", body: "the quarterly numbers are in" });
    await r.add({ id: "m2", subject: "Two", body: "numbers from the quarterly review" });

    expect(r.find('"quarterly numbers"')).toEqual(["m1"]);
  });

  it("excludes a negated term", async () => {
    const r = open();
    await r.add({ id: "m1", body: "invoice for hosting" });
    await r.add({ id: "m2", body: "invoice for lunch" });

    expect(r.find("invoice -lunch")).toEqual(["m1"]);
  });

  it("does not choke on FTS5 syntax a person might type", async () => {
    const r = open();
    await r.add({ id: "m1", body: "a plain message" });

    // Unescaped, each of these is a syntax error from SQLite — and a search box
    // that errors on the word "OR" is broken.
    for (const query of ["a OR b", "NEAR(a b)", "*", "^start", "a AND", '"'.repeat(3)]) {
      expect(() => r.find(query), query).not.toThrow();
    }
  });

  it("returns a snippet rather than the whole body", async () => {
    const r = open();
    await r.add({ id: "m1", body: `${"padding ".repeat(80)}needle ${"padding ".repeat(80)}` });

    const [hit] = r.searcher.search("needle", { accountId: ACCOUNT, now: NOW });
    expect(hit?.snippet).toContain("needle");
    expect(hit?.snippet.length).toBeLessThan(200);
  });
});

describe("structured filters", () => {
  it("filters by sender and recipient", async () => {
    const r = open();
    await r.add({ id: "m1", from: "Asha <asha@example.org>" });
    await r.add({ id: "m2", from: "Ravi <ravi@example.org>" });

    expect(r.find("from:asha")).toEqual(["m1"]);
    expect(r.find("-from:asha")).toEqual(["m2"]);
  });

  it("filters by subject independently of the body", async () => {
    const r = open();
    await r.add({ id: "m1", subject: "Invoice 4471", body: "nothing here" });
    await r.add({ id: "m2", subject: "Lunch", body: "invoice mentioned in the body" });

    expect(r.find("subject:invoice")).toEqual(["m1"]);
  });

  it("filters by mailbox, by name or by id", async () => {
    const r = open();
    await seedMailboxes(r);
    await r.add({ id: "m1", mailbox: INBOX });
    await r.add({ id: "m2", mailbox: ARCHIVE });

    expect(r.find("in:inbox")).toEqual(["m1"]);
    expect(r.find(`in:${ARCHIVE}`)).toEqual(["m2"]);
  });

  it("filters by read state", async () => {
    const r = open();
    await r.add({ id: "m1", keywords: ["$seen"] });
    await r.add({ id: "m2", keywords: [] });

    expect(r.find("is:unread")).toEqual(["m2"]);
    expect(r.find("is:read")).toEqual(["m1"]);
  });

  it("filters by attachment", async () => {
    const r = open();
    await r.add({ id: "m1", attachment: true });
    await r.add({ id: "m2" });

    expect(r.find("has:attachment")).toEqual(["m1"]);
    expect(r.find("-has:attachment")).toEqual(["m2"]);
  });

  it("filters by date range", async () => {
    const r = open();
    await r.add({ id: "old", daysAgo: 400 });
    await r.add({ id: "recent", daysAgo: 1 });

    expect(r.find("after:2026")).toEqual(["recent"]);
    expect(r.find("before:2026")).toEqual(["old"]);
  });

  it("answers a query with no text at all", async () => {
    const r = open();
    await seedMailboxes(r);
    await r.add({ id: "m1", mailbox: INBOX, keywords: [] });
    await r.add({ id: "m2", mailbox: INBOX, keywords: ["$seen"] });

    // `in:inbox is:unread` has nothing to rank. Sending an empty match
    // expression to FTS5 would return nothing at all.
    expect(r.find("in:inbox is:unread")).toEqual(["m1"]);
  });

  it("combines text with filters", async () => {
    const r = open();
    await r.add({ id: "m1", body: "the invoice", keywords: [] });
    await r.add({ id: "m2", body: "the invoice", keywords: ["$seen"] });

    expect(r.find("invoice is:unread")).toEqual(["m1"]);
  });
});

describe("ranking", () => {
  it("prefers a recent mediocre match to an old perfect one", async () => {
    const r = open();
    await r.add({ id: "old", body: "invoice invoice invoice invoice invoice", daysAgo: 900 });
    await r.add({ id: "recent", body: "one mention of an invoice here", daysAgo: 0 });

    // Mail is not documents. A mediocre match from this morning usually beats a
    // perfect one from 2019.
    expect(r.find("invoice")[0]).toBe("recent");
  });

  it("falls back to pure relevance when the boost is off", async () => {
    const r = open();
    await r.add({ id: "old", body: "invoice invoice invoice invoice invoice", daysAgo: 900 });
    await r.add({ id: "recent", body: "one mention of an invoice here", daysAgo: 0 });

    expect(r.find("invoice", { recencyWeight: 0 })[0]).toBe("old");
  });

  it("orders a filter-only query newest first", async () => {
    const r = open();
    await r.add({ id: "older", daysAgo: 5 });
    await r.add({ id: "newer", daysAgo: 1 });

    expect(r.find("is:unread")).toEqual(["newer", "older"]);
  });

  it("honours the limit", async () => {
    const r = open();
    for (let i = 0; i < 5; i++) await r.add({ id: `m${i}`, body: "invoice", daysAgo: i });
    expect(r.find("invoice", { limit: 2 })).toHaveLength(2);
  });
});

describe("index maintenance", () => {
  it("is idempotent: re-indexing the same message does not duplicate it", async () => {
    const r = open();
    await r.add({ id: "m1", body: "invoice" });
    await r.add({ id: "m1", body: "invoice" });

    // A message is re-indexed every time its keywords change, so this is the
    // normal path rather than an edge case.
    expect(r.find("invoice")).toEqual(["m1"]);
    expect(r.index.count(ACCOUNT)).toBe(1);
  });

  it("reflects a re-index rather than keeping the old text", async () => {
    const r = open();
    await r.add({ id: "m1", body: "invoice" });
    r.index.index([
      {
        messageId: messageId("m1"),
        accountId: ACCOUNT,
        subject: "",
        sender: "",
        recipients: "",
        body: "receipt",
      },
    ]);

    expect(r.find("invoice")).toEqual([]);
    expect(r.find("receipt")).toEqual(["m1"]);
  });

  it("drops a removed message from results", async () => {
    const r = open();
    await r.add({ id: "m1", body: "invoice" });
    r.index.remove([messageId("m1")]);
    expect(r.find("invoice")).toEqual([]);
  });

  it("can never return a message the store no longer has", async () => {
    const r = open();
    await r.add({ id: "m1", body: "invoice" });
    // Leave the index alone and delete the message underneath it. The join to
    // `messages` means a stale index can only under-return, never invent a hit.
    r.store.driver.exec("delete from messages where id = 'm1'");
    expect(r.find("invoice")).toEqual([]);
  });

  it("is cleared by a store rebuild, which the app must then repopulate", async () => {
    const r = open();
    await r.add({ id: "m1", body: "invoice" });
    expect(r.index.count(ACCOUNT)).toBe(1);

    await r.store.rebuild(ACCOUNT);

    // The index is a projection and a rebuild empties it. Refilling it needs
    // body text, which only the app can produce — so this is documented
    // behaviour, not a bug.
    expect(r.index.count(ACCOUNT)).toBe(0);
    expect(r.find("invoice")).toEqual([]);
  });

  it("clears one account without touching another", async () => {
    const r = open();
    await r.add({ id: "m1", body: "invoice" });
    r.index.clear(accountId("someone-else"));
    expect(r.index.count(ACCOUNT)).toBe(1);
  });
});
