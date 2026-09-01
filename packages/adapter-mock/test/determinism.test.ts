import { intentId } from "@daak/contracts";
import { describe, expect, it } from "vitest";
import { createMockProvider } from "../src/provider.js";
import { createRng, seedFrom } from "../src/rng.js";

/**
 * A chaos harness that cannot reproduce its own failures is a random number
 * generator with extra steps. These tests are the guarantee everything else
 * relies on.
 */
describe("determinism", () => {
  it("produces identical sequences for the same seed", () => {
    const a = createRng(seedFrom("bug-4471"));
    const b = createRng(seedFrom("bug-4471"));
    const drawA = Array.from({ length: 40 }, () => a.next());
    const drawB = Array.from({ length: 40 }, () => b.next());
    expect(drawA).toEqual(drawB);
  });

  it("produces different sequences for different seeds", () => {
    const a = Array.from({ length: 20 }, createRng(1).next);
    const b = Array.from({ length: 20 }, createRng(2).next);
    expect(a).not.toEqual(b);
  });

  it("shuffles without mutating the input", () => {
    const rng = createRng(7);
    const input = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8]);
    const shuffled = rng.shuffle(input);
    expect(shuffled).not.toBe(input);
    expect([...shuffled].sort((x, y) => x - y)).toEqual([...input]);
  });

  it("replays a whole scripted session identically", async () => {
    const run = async (seed: string) => {
      const provider = createMockProvider({ seed });
      for (let i = 0; i < 5; i++) {
        provider.server.addMessage({ raw: `Subject: ${i}\r\n\r\nBody ${i}\r\n` });
      }
      provider.faults.inject({ op: "changes", kind: "reorder-batch", probability: 0.5 });
      provider.faults.inject({ op: "*", kind: "duplicate-events", probability: 0.3 });

      const observed: string[] = [];
      let cursor: string | null = null;
      for (let round = 0; round < 6; round++) {
        try {
          const batch = await provider.changes({ collection: "message", cursor, limit: 3 });
          observed.push(batch.changes.map((c) => `${c.kind}:${c.providerId}`).join(","));
          cursor = batch.cursor;
        } catch (error) {
          observed.push(`error:${(error as { code?: string }).code ?? "?"}`);
        }
        await provider.apply([
          {
            intentId: intentId(`i-${round}`),
            mutation: { kind: "keywords.change", providerIds: ["M1"], add: ["$seen"], remove: [] },
          },
        ]);
      }
      return { observed, faults: [...provider.faults.fired], snapshot: provider.server.snapshot() };
    };

    expect(await run("session-a")).toEqual(await run("session-a"));
  });

  it("keeps an unrelated call from consuming randomness", async () => {
    // A probability draw happens only for a rule that already matched on op, so
    // adding an unrelated call to a test must not shift every later coin flip.
    const provider = createMockProvider({ seed: "stability" });
    provider.faults.inject({ op: "changes", kind: "rate-limit", probability: 0.5 });

    await provider.listMailboxes();
    await provider.listMailboxes();
    await provider.fetchMetadata([]);

    const bare = createMockProvider({ seed: "stability" });
    bare.faults.inject({ op: "changes", kind: "rate-limit", probability: 0.5 });

    const outcomes = async (p: typeof provider) => {
      const results: string[] = [];
      for (let i = 0; i < 8; i++) {
        try {
          await p.changes({ collection: "message", cursor: null, limit: 5 });
          results.push("ok");
        } catch {
          results.push("rate-limited");
        }
      }
      return results;
    };

    expect(await outcomes(provider)).toEqual(await outcomes(bare));
  });
});
