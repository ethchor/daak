import { intentId, type ProviderIntent } from "@daak/contracts";
import { loadFixture } from "@daak/fixtures";
import { describe, expect, it } from "vitest";
import { createMockProvider } from "../src/provider.js";

const intent = (id: string, mutation: ProviderIntent["mutation"]): ProviderIntent => ({
  intentId: intentId(id),
  mutation,
});

describe("MailProvider conformance", () => {
  it("reports its own limits rather than expecting callers to guess", async () => {
    const provider = createMockProvider({ maxObjectsPerFetch: 42 });
    const capabilities = await provider.capabilities();
    expect(capabilities.maxObjectsPerFetch).toBe(42);
    expect(capabilities.supportsIncrementalChanges).toBe(true);
  });

  it("refuses a fetch larger than the limit it advertised", async () => {
    const provider = createMockProvider({ maxObjectsPerFetch: 2 });
    await expect(provider.fetchMetadata(["M1", "M2", "M3"])).rejects.toMatchObject({
      kind: "permanent",
      code: "input.invalid",
    });
  });

  it("returns raw bytes untouched", async () => {
    const provider = createMockProvider();
    const fixture = loadFixture("multipart-mixed-attachment");
    provider.server.addMessage({ raw: fixture.raw, providerId: "MX" });

    const fetched = await provider.fetchRaw("MX");
    expect(Array.from(fetched)).toEqual(Array.from(fixture.raw));
  });

  it("hands out a copy, so a caller cannot corrupt server state", async () => {
    const provider = createMockProvider();
    provider.server.addMessage({ raw: "Subject: x\r\n\r\nbody\r\n", providerId: "MX" });

    const fetched = await provider.fetchRaw("MX");
    fetched[0] = 0;
    const again = await provider.fetchRaw("MX");
    expect(again[0]).not.toBe(0);
  });

  it("distinguishes created from updated relative to the caller's cursor", async () => {
    const provider = createMockProvider();
    provider.server.addMessage({ raw: "Subject: 1\r\n\r\na\r\n" });
    const cursor = String(provider.server.state);

    provider.server.addMessage({ raw: "Subject: 2\r\n\r\nb\r\n" });
    provider.server.touch("M1", (m) => m.keywords.add("$seen"));

    const batch = await provider.changes({ collection: "message", cursor, limit: 10 });
    expect(batch.changes).toEqual([
      { kind: "created", providerId: "M2" },
      { kind: "updated", providerId: "M1" },
    ]);
  });

  it("never advances the cursor past what it returned", async () => {
    const provider = createMockProvider();
    for (let i = 0; i < 5; i++) provider.server.addMessage({ raw: `Subject: ${i}\r\n\r\nx\r\n` });

    const first = await provider.changes({ collection: "message", cursor: null, limit: 2 });
    expect(first.changes).toHaveLength(2);
    expect(first.hasMore).toBe(true);

    const second = await provider.changes({
      collection: "message",
      cursor: first.cursor,
      limit: 10,
    });
    const seen = [...first.changes, ...second.changes].map((c) => c.providerId);
    expect(new Set(seen).size).toBe(5); // nothing skipped, nothing lost
  });

  it("applies keyword and mailbox changes as add/remove sets", async () => {
    const provider = createMockProvider();
    provider.server.addMessage({ raw: "Subject: x\r\n\r\nx\r\n", keywords: ["$flagged"] });

    await provider.apply([
      intent("i1", {
        kind: "keywords.change",
        providerIds: ["M1"],
        add: ["$seen"],
        remove: ["$flagged"],
      }),
      intent("i2", {
        kind: "mailboxes.change",
        providerIds: ["M1"],
        add: ["ARCHIVE"],
        remove: ["INBOX"],
      }),
    ]);

    expect(provider.server.snapshot().M1).toEqual({
      keywords: ["$seen"],
      mailboxes: ["ARCHIVE"],
      destroyed: false,
    });
  });

  it("returns the id of anything it created, so the engine can map it", async () => {
    const provider = createMockProvider();
    const { providerBlobId } = await provider.uploadBlob(
      new TextEncoder().encode("Subject: draft\r\n\r\nhalf a thought\r\n"),
    );

    const [outcome] = await provider.apply([
      intent("i1", { kind: "draft.save", providerBlobId, mailboxProviderId: "DRAFTS" }),
    ]);

    expect(outcome?.status).toBe("applied");
    expect(outcome?.createdProviderId).toBeDefined();
    const created = provider.server.require(outcome?.createdProviderId ?? "");
    expect([...created.keywords]).toEqual(["$draft"]);
  });

  it("rejects one intent without failing the batch", async () => {
    const provider = createMockProvider();
    provider.server.addMessage({ raw: "Subject: x\r\n\r\nx\r\n" });

    const outcomes = await provider.apply([
      intent("ok", { kind: "keywords.change", providerIds: ["M1"], add: ["$seen"], remove: [] }),
      intent("bad", { kind: "mailbox.rename", providerId: "NOPE", name: "Nope" }),
    ]);

    expect(outcomes.map((o) => o.status)).toEqual(["applied", "rejected"]);
    expect(outcomes[1]?.error?.code).toBe("resource.not_found");
  });

  it("is idempotent: replaying an intent returns the original outcome", async () => {
    const provider = createMockProvider();
    provider.server.addMessage({ raw: "Subject: x\r\n\r\nx\r\n" });

    const mutation = intent("same-id", {
      kind: "keywords.change",
      providerIds: ["M1"],
      add: ["$seen"],
      remove: [],
    });

    const [first] = await provider.apply([mutation]);
    const stateAfterFirst = provider.server.state;
    const [second] = await provider.apply([mutation]);

    expect(second).toEqual(first);
    // The replay changed nothing. Without this, a retry after an ambiguous
    // failure applies the mutation twice.
    expect(provider.server.state).toBe(stateAfterFirst);
  });

  it("deduplicates submissions by idempotency key", async () => {
    const provider = createMockProvider();
    const { providerBlobId } = await provider.uploadBlob(
      new TextEncoder().encode("Subject: hello\r\n\r\nhi\r\n"),
    );
    const request = {
      providerBlobId,
      mailFrom: { name: "", address: "me@example.org" },
      rcptTo: [{ name: "", address: "you@example.net" }],
      idempotencyKey: "submit-1",
    };

    const first = await provider.submit(request);
    const second = await provider.submit(request);

    expect(second).toEqual(first);
    const sent = [...provider.server.messages.values()].filter((m) =>
      m.mailboxProviderIds.has("SENT"),
    );
    expect(sent).toHaveLength(1); // sent once, not twice
  });

  it("refuses a submission with no recipients", async () => {
    const provider = createMockProvider();
    const { providerBlobId } = await provider.uploadBlob(
      new TextEncoder().encode("Subject: x\r\n\r\nx\r\n"),
    );
    await expect(
      provider.submit({
        providerBlobId,
        mailFrom: { name: "", address: "me@example.org" },
        rcptTo: [],
        idempotencyKey: "empty",
      }),
    ).rejects.toMatchObject({ kind: "permanent" });
  });

  it("notifies watchers and stops after unsubscribe", async () => {
    const provider = createMockProvider();
    provider.server.addMessage({ raw: "Subject: x\r\n\r\nx\r\n" });

    const seen: string[] = [];
    const unsubscribe = provider.watch?.((collection) => seen.push(collection));

    await provider.apply([
      intent("i1", { kind: "keywords.change", providerIds: ["M1"], add: ["$seen"], remove: [] }),
    ]);
    unsubscribe?.();
    await provider.apply([
      intent("i2", { kind: "keywords.change", providerIds: ["M1"], add: ["$flagged"], remove: [] }),
    ]);

    expect(seen).toEqual(["message"]);
  });

  it("refuses work after close", async () => {
    const provider = createMockProvider();
    await provider.close();
    await expect(provider.listMailboxes()).rejects.toMatchObject({ kind: "permanent" });
  });

  it("honours an abort signal", async () => {
    const provider = createMockProvider();
    const controller = new AbortController();
    controller.abort();
    await expect(provider.listMailboxes({ signal: controller.signal })).rejects.toMatchObject({
      kind: "transient",
    });
  });
});
