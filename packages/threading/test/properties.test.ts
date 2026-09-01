import { accountId, type Instant, messageId } from "@daak/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { threadMessages } from "../src/thread.js";
import type { ThreadableMessage } from "../src/types.js";

const ACCOUNT = accountId("prop");

/**
 * Properties, not examples.
 *
 * These three hold for *any* mailbox, including ones no fixture describes:
 * cycles, self-references, duplicate ids, missing ancestors, empty subjects.
 * They are what catches the case nobody thought to write a test for.
 */
const arbMessage = fc.record({
  index: fc.integer({ min: 0, max: 40 }),
  hasMessageId: fc.boolean(),
  midPool: fc.integer({ min: 0, max: 12 }),
  refs: fc.array(fc.integer({ min: 0, max: 12 }), { maxLength: 4 }),
  inReplyTo: fc.option(fc.integer({ min: 0, max: 12 }), { nil: undefined }),
  subjectPool: fc.integer({ min: 0, max: 5 }),
  isReply: fc.boolean(),
});

const SUBJECTS = ["Quarterly numbers", "Lunch", "", "Bug: crash", "[devs] Proposal", "Numbers"];

interface MessageSpec {
  index: number;
  hasMessageId: boolean;
  midPool: number;
  refs: number[];
  inReplyTo: number | undefined;
  subjectPool: number;
  isReply: boolean;
}

const build = (specs: readonly MessageSpec[]): ThreadableMessage[] =>
  specs.map((s, i): ThreadableMessage => {
    const subject = SUBJECTS[s.subjectPool] ?? "";
    return {
      id: messageId(`m${i}`),
      messageIdHeader: s.hasMessageId ? [`id${s.midPool}@example.org`] : [],
      inReplyTo: s.inReplyTo === undefined ? [] : [`id${s.inReplyTo}@example.org`],
      references: s.refs.map((r) => `id${r}@example.org`),
      subject: s.isReply ? `Re: ${subject}` : subject,
      receivedAt: new Date(Date.UTC(2026, 0, 1, 0, s.index, 0)).toISOString() as Instant,
      from: [{ name: "", address: `s${i}@example.org` }],
      to: [],
      cc: [],
    };
  });

const arbMailbox = fc.array(arbMessage, { maxLength: 25 });

describe("threading properties", () => {
  it("places every message exactly once, whatever the input", () => {
    fc.assert(
      fc.property(arbMailbox, (specs) => {
        const messages = build(specs);
        const placed = threadMessages({ accountId: ACCOUNT, messages }).flatMap(
          (thread) => thread.messageIds,
        );
        // No message lost to a cycle, a duplicate id, or a missing ancestor.
        expect(placed).toHaveLength(messages.length);
        expect(new Set(placed).size).toBe(messages.length);
      }),
      { numRuns: 300 },
    );
  });

  it("is independent of the order messages arrive in", () => {
    fc.assert(
      fc.property(arbMailbox, fc.integer(), (specs, seed) => {
        const messages = build(specs);
        // A deterministic permutation, so a failure reproduces from the seed.
        const rotated = messages
          .map((_, i) => messages[(i + Math.abs(seed)) % Math.max(1, messages.length)])
          .filter((m): m is ThreadableMessage => m !== undefined);

        expect(threadMessages({ accountId: ACCOUNT, messages: rotated })).toEqual(
          threadMessages({ accountId: ACCOUNT, messages }),
        );
      }),
      { numRuns: 200 },
    );
  });

  it("keeps thread state internally consistent", () => {
    fc.assert(
      fc.property(arbMailbox, (specs) => {
        const messages = build(specs);
        for (const thread of threadMessages({ accountId: ACCOUNT, messages })) {
          expect(thread.messageCount).toBe(thread.messageIds.length);
          expect(thread.messageCount).toBeGreaterThan(0);
          // lastMessageAt really is the latest, not merely the last appended.
          const times = thread.messageIds.map(
            (id) => messages.find((m) => m.id === id)?.receivedAt ?? "",
          );
          expect(thread.lastMessageAt).toBe([...times].sort().at(-1));
        }
      }),
      { numRuns: 300 },
    );
  });
});
