import { accountId, type Instant, type MessageId, messageId } from "@daak/contracts";
import { loadAll } from "@daak/fixtures";
import { parseMessage } from "@daak/mime";
import { beforeAll, describe, expect, it } from "vitest";
import { threadMessages } from "../src/thread.js";
import type { ThreadableMessage } from "../src/types.js";

/**
 * Threading over the real corpus, parsed by the real parser.
 *
 * The unit tests use synthetic messages so a failure points at one rule. This
 * suite is the end-to-end check: whatever `@daak/mime` actually produces from
 * the fixtures is what threading has to cope with.
 */
const ACCOUNT = accountId("corpus");

let messages: ThreadableMessage[] = [];

beforeAll(async () => {
  const fixtures = loadAll();
  messages = await Promise.all(
    fixtures.map(async (fixture, index) => {
      const parsed = await parseMessage(fixture.raw);
      return {
        id: messageId(fixture.id),
        messageIdHeader: parsed.envelope.messageIdHeader,
        inReplyTo: parsed.envelope.inReplyTo,
        references: parsed.envelope.references,
        subject: parsed.envelope.subject,
        // Stand in for the server's received time with the Date header, so the
        // corpus threads in the order a real mailbox would have taken delivery.
        // One fixture's date is deliberately unparseable; it falls back to a
        // stable per-fixture slot rather than to the clock.
        receivedAt:
          parsed.envelope.sentAt ??
          (new Date(Date.UTC(2026, 11, 1, 0, index, 0)).toISOString() as Instant),
        from: parsed.envelope.from,
        to: parsed.envelope.to,
        cc: parsed.envelope.cc,
      } satisfies ThreadableMessage;
    }),
  );
});

const threadContaining = (id: string) => {
  const threads = threadMessages({ accountId: ACCOUNT, messages });
  return threads.find((thread) => thread.messageIds.includes(id as MessageId));
};

describe("corpus threading", () => {
  it("accounts for every message exactly once", () => {
    const threads = threadMessages({ accountId: ACCOUNT, messages });
    const placed = threads.flatMap((thread) => thread.messageIds);
    expect(placed).toHaveLength(messages.length);
    expect(new Set(placed).size).toBe(messages.length);
  });

  it("joins a reply to its parent through In-Reply-To alone", () => {
    // no-references-reply has In-Reply-To and no References. Its fixture
    // declares parentOf: simple-plaintext.
    const found = threadContaining("no-references-reply");
    expect(found?.messageIds).toContain("simple-plaintext");
  });

  it("pulls in a reply that has neither In-Reply-To nor References", () => {
    // subject-only-thread is "RE: Quarterly numbers" with no ancestry at all.
    // The subject fallback is the only thing that can place it.
    const found = threadContaining("subject-only-thread");
    expect(found?.messageIds).toContain("simple-plaintext");
  });

  it("gives the thread the root's subject, prefixes stripped", () => {
    expect(threadContaining("simple-plaintext")?.subject).toBe("Quarterly numbers");
  });

  it("keeps a forward out of the conversation it quotes", () => {
    // nested-rfc822-forward is "Fwd: Quarterly numbers" with no references.
    // Same words, different conversation.
    const found = threadContaining("nested-rfc822-forward");
    expect(found?.messageIds).toEqual(["nested-rfc822-forward"]);
  });

  it("does not merge on a reused Message-ID", () => {
    // duplicate-message-id reuses simple-plaintext's id with unrelated content.
    // It may not swallow, or be swallowed by, the real thread.
    const found = threadContaining("duplicate-message-id");
    expect(found?.messageIds).toEqual(["duplicate-message-id"]);
  });

  it("leaves unrelated mail in threads of its own", () => {
    for (const id of ["list-mail", "invoice", "charset-shift-jis", "calendar-invite"]) {
      const found = threadContaining(id);
      if (found === undefined) continue;
      expect(`${id}:${found.messageCount}`).toBe(`${id}:1`);
    }
  });

  it("is order-independent over the whole corpus", () => {
    const forward = threadMessages({ accountId: ACCOUNT, messages });
    const backward = threadMessages({ accountId: ACCOUNT, messages: [...messages].reverse() });
    expect(backward).toEqual(forward);
  });

  it("produces thread ids that survive a rebuild", () => {
    const first = threadMessages({ accountId: ACCOUNT, messages }).map((t) => t.id);
    const second = threadMessages({ accountId: ACCOUNT, messages: [...messages].reverse() }).map(
      (t) => t.id,
    );
    expect(second).toEqual(first);
  });
});
