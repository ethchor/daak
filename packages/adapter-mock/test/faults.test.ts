import { intentId, type ProviderIntent } from "@daak/contracts";
import { describe, expect, it } from "vitest";
import { createMockProvider } from "../src/provider.js";

const seen = (id: string): ProviderIntent => ({
  intentId: intentId(id),
  mutation: { kind: "keywords.change", providerIds: ["M1"], add: ["$seen"], remove: [] },
});

const withMessages = (count: number, seed = "faults") => {
  const provider = createMockProvider({ seed });
  for (let i = 1; i <= count; i++) {
    provider.server.addMessage({ raw: `Subject: ${i}\r\n\r\nbody ${i}\r\n` });
  }
  return provider;
};

describe("fault: disconnect", () => {
  it("fails before the server does any work", async () => {
    const provider = withMessages(1);
    provider.faults.once("apply", "disconnect");

    await expect(provider.apply([seen("i1")])).rejects.toMatchObject({
      kind: "transient",
      code: "net.unreachable",
    });
    // Nothing applied — this one IS safe to retry.
    expect(provider.server.snapshot().M1?.keywords).toEqual([]);
  });
});

describe("fault: apply-then-fail", () => {
  /**
   * The reason this package exists. Everything below is the ambiguous timeout:
   * the mutation is committed server-side and the client is told it failed.
   */
  it("commits the mutation and then fails the response", async () => {
    const provider = withMessages(1);
    provider.faults.once("apply", "apply-then-fail");

    await expect(provider.apply([seen("i1")])).rejects.toMatchObject({
      kind: "transient",
      code: "net.timeout",
    });

    // The client saw a failure. The server disagrees.
    expect(provider.server.snapshot().M1?.keywords).toEqual(["$seen"]);
  });

  it("makes the safe retry a no-op, because the intent id is the idempotency key", async () => {
    const provider = withMessages(1);
    provider.faults.once("apply", "apply-then-fail");

    await expect(provider.apply([seen("i1")])).rejects.toThrow();
    const stateAfterAmbiguousFailure = provider.server.state;

    // What a correct engine does: resend the SAME intent id rather than
    // rolling back or issuing a fresh mutation.
    const [outcome] = await provider.apply([seen("i1")]);

    expect(outcome?.status).toBe("applied");
    expect(provider.server.state).toBe(stateAfterAmbiguousFailure);
    expect(provider.server.snapshot().M1?.keywords).toEqual(["$seen"]);
  });

  it("applies a destroy exactly once across an ambiguous retry", async () => {
    const provider = withMessages(2);
    provider.faults.once("apply", "apply-then-fail");
    const destroy: ProviderIntent = {
      intentId: intentId("d1"),
      mutation: { kind: "message.destroy", providerIds: ["M1"] },
    };

    await expect(provider.apply([destroy])).rejects.toThrow();
    const afterFirst = provider.server.state;
    await provider.apply([destroy]);

    expect(provider.server.state).toBe(afterFirst);
    expect(provider.server.snapshot().M1?.destroyed).toBe(true);
    expect(provider.server.snapshot().M2?.destroyed).toBe(false);
  });

  it("accepts a submission and then loses the response", async () => {
    const provider = createMockProvider({ seed: "submit-fault" });
    const { providerBlobId } = await provider.uploadBlob(
      new TextEncoder().encode("Subject: hi\r\n\r\nhi\r\n"),
    );
    const request = {
      providerBlobId,
      mailFrom: { name: "", address: "me@example.org" },
      rcptTo: [{ name: "", address: "you@example.net" }],
      idempotencyKey: "s1",
    };
    provider.faults.once("submit", "apply-then-fail");

    await expect(provider.submit(request)).rejects.toMatchObject({ kind: "transient" });

    // It went out. Resending without the key is how a message is sent twice.
    const sentBefore = [...provider.server.messages.values()].filter((m) =>
      m.mailboxProviderIds.has("SENT"),
    ).length;
    await provider.submit(request);
    const sentAfter = [...provider.server.messages.values()].filter((m) =>
      m.mailboxProviderIds.has("SENT"),
    ).length;

    expect(sentBefore).toBe(1);
    expect(sentAfter).toBe(1);
  });
});

describe("fault: rate-limit", () => {
  it("says how long to wait", async () => {
    const provider = withMessages(1);
    provider.faults.once("changes", "rate-limit");
    await expect(
      provider.changes({ collection: "message", cursor: null, limit: 10 }),
    ).rejects.toMatchObject({
      kind: "transient",
      code: "net.rate_limited",
      retryAfterMs: 30_000,
    });
  });
});

describe("fault: expire-cursor", () => {
  it("is a conflict, not a permanent failure", async () => {
    const provider = withMessages(3);
    provider.faults.once("changes", "expire-cursor");
    await expect(
      provider.changes({ collection: "message", cursor: "1", limit: 10 }),
    ).rejects.toMatchObject({
      kind: "conflict",
      code: "sync.cursor_invalid",
    });
  });
});

describe("fault: duplicate-events", () => {
  it("reports the same change twice in one batch", async () => {
    const provider = withMessages(3);
    provider.faults.once("changes", "duplicate-events");

    const batch = await provider.changes({ collection: "message", cursor: null, limit: 10 });
    const ids = batch.changes.map((c) => c.providerId);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(3);
  });
});

describe("fault: reorder-batch", () => {
  it("delivers changes out of the order they happened in", async () => {
    const provider = withMessages(6, "reorder-seed");
    provider.faults.once("changes", "reorder-batch");

    const batch = await provider.changes({ collection: "message", cursor: null, limit: 10 });
    const ids = batch.changes.map((c) => c.providerId);

    expect([...ids].sort()).toEqual(["M1", "M2", "M3", "M4", "M5", "M6"].sort());
    expect(ids).not.toEqual(["M1", "M2", "M3", "M4", "M5", "M6"]);
  });
});

describe("fault: stale-read", () => {
  it("returns state from before the last write", async () => {
    const provider = withMessages(1);
    provider.server.touch("M1", (m) => m.keywords.add("$seen"));
    provider.faults.once("fetchMetadata", "stale-read");

    const [stale] = await provider.fetchMetadata(["M1"]);
    expect(stale?.keywords).toEqual([]);

    const [fresh] = await provider.fetchMetadata(["M1"]);
    expect(fresh?.keywords).toEqual(["$seen"]);
  });
});

describe("fault: short-batch", () => {
  it("returns fewer changes than asked for, with more still waiting", async () => {
    const provider = withMessages(5);
    provider.faults.once("changes", "short-batch");

    const batch = await provider.changes({ collection: "message", cursor: null, limit: 5 });

    // A client that reads a short batch as "that's everything" stalls here.
    expect(batch.changes.length).toBeLessThan(5);
    expect(batch.hasMore).toBe(true);

    const rest = await provider.changes({ collection: "message", cursor: batch.cursor, limit: 10 });
    const all = [...batch.changes, ...rest.changes].map((c) => c.providerId);
    expect(new Set(all).size).toBe(5); // and nothing was actually lost
  });
});

describe("fault rules", () => {
  it("fires a limited number of times", async () => {
    const provider = withMessages(1);
    provider.faults.inject({ op: "listMailboxes", kind: "disconnect", times: 2 });

    await expect(provider.listMailboxes()).rejects.toThrow();
    await expect(provider.listMailboxes()).rejects.toThrow();
    await expect(provider.listMailboxes()).resolves.toBeDefined();
  });

  it("matches every operation with a wildcard", async () => {
    const provider = withMessages(1);
    provider.faults.inject({ op: "*", kind: "disconnect", times: 1 });
    await expect(provider.listMailboxes()).rejects.toThrow();
    await expect(provider.fetchRaw("M1")).resolves.toBeDefined();
  });

  it("records what fired, in order", async () => {
    const provider = withMessages(1);
    provider.faults.once("listMailboxes", "rate-limit");
    provider.faults.once("fetchRaw", "disconnect");

    await expect(provider.listMailboxes()).rejects.toThrow();
    await expect(provider.fetchRaw("M1")).rejects.toThrow();

    expect(provider.faults.fired).toEqual([
      { op: "listMailboxes", kind: "rate-limit" },
      { op: "fetchRaw", kind: "disconnect" },
    ]);
  });

  it("clears rules and history", async () => {
    const provider = withMessages(1);
    provider.faults.inject({ op: "*", kind: "disconnect" });
    await expect(provider.listMailboxes()).rejects.toThrow();

    provider.faults.clear();
    await expect(provider.listMailboxes()).resolves.toBeDefined();
    expect(provider.faults.fired).toHaveLength(0);
  });
});
