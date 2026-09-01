import { describe, expect, it } from "vitest";
import { MockServer, toProviderMessage } from "../src/server.js";

const message = (n: number) => `Message-ID: <m${n}@example.org>\r\nSubject: ${n}\r\n\r\nBody\r\n`;

describe("MockServer", () => {
  it("ships the standard mailbox roles", () => {
    const roles = new MockServer().listMailboxes().map((m) => m.role);
    expect(roles).toContain("inbox");
    expect(roles).toContain("sent");
    expect(roles).toContain("trash");
  });

  it("advances state exactly once per mutation", () => {
    const server = new MockServer();
    const before = server.state;
    server.addMessage({ raw: message(1) });
    expect(server.state).toBe(before + 1);

    server.touch("M1", (m) => m.keywords.add("$seen"));
    expect(server.state).toBe(before + 2);
  });

  it("reports only what changed after a cursor", () => {
    const server = new MockServer();
    server.addMessage({ raw: message(1) });
    const cursor = String(server.state);
    server.addMessage({ raw: message(2) });

    const { messages } = server.changesSince(cursor, 10);
    expect(messages.map((m) => m.providerId)).toEqual(["M2"]);
  });

  it("keeps a tombstone so a deletion can be reported", () => {
    const server = new MockServer();
    server.addMessage({ raw: message(1) });
    const cursor = String(server.state);
    server.destroy("M1");

    const { messages } = server.changesSince(cursor, 10);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.destroyed).toBe(true);
    // A server that forgets a deletion can never report it, and the client
    // keeps the message forever.
    expect(server.messages.has("M1")).toBe(true);
  });

  it("rejects a cursor that has fallen out of the history window", () => {
    const server = new MockServer({ historyWindow: 3 });
    server.addMessage({ raw: message(1) });
    const stale = String(server.state);
    for (let i = 2; i <= 6; i++) server.addMessage({ raw: message(i) });

    expect(() => server.changesSince(stale, 10)).toThrowError(/history window/);
    try {
      server.changesSince(stale, 10);
    } catch (error) {
      // Must be `conflict`: the fix is a resynchronise. Classifying it
      // `permanent` strands the account forever.
      expect((error as { kind: string }).kind).toBe("conflict");
    }
  });

  it("rejects a cursor from the future", () => {
    const server = new MockServer();
    server.addMessage({ raw: message(1) });
    expect(() => server.changesSince("9999", 10)).toThrowError();
    expect(() => server.changesSince("not-a-number", 10)).toThrowError();
  });

  it("pages backfill newest-first without repeating or skipping", () => {
    const server = new MockServer();
    for (let i = 1; i <= 7; i++) server.addMessage({ raw: message(i) });

    const seen: string[] = [];
    let watermark: string | null = null;
    let complete = false;
    while (!complete) {
      const page = server.backfillFrom(watermark, 3);
      seen.push(...page.messages.map((m) => m.providerId));
      watermark = page.lowWatermark;
      complete = page.complete;
    }

    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect(seen[0]).toBe("M7"); // newest first
  });

  it("derives received timestamps from state, never from the clock", () => {
    const a = new MockServer();
    const b = new MockServer();
    a.addMessage({ raw: message(1) });
    b.addMessage({ raw: message(1) });
    expect(a.require("M1").receivedAt).toBe(b.require("M1").receivedAt);
  });

  it("exposes the previous state for a faithful stale read", () => {
    const server = new MockServer();
    server.addMessage({ raw: message(1), keywords: [] });
    server.touch("M1", (m) => m.keywords.add("$seen"));

    expect(toProviderMessage(server.require("M1")).keywords).toEqual(["$seen"]);
    expect(toProviderMessage(server.require("M1"), true).keywords).toEqual([]);
  });
});
