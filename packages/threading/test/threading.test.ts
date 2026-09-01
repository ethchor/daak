import { accountId, type Instant, messageId } from "@daak/contracts";
import { describe, expect, it } from "vitest";
import { normaliseSubject } from "../src/subject.js";
import { threadMessages } from "../src/thread.js";
import type { ThreadableMessage } from "../src/types.js";

const ACCOUNT = accountId("a1");

let clock = 0;
const at = (minute: number): Instant =>
  new Date(Date.UTC(2026, 7, 1, 0, minute, 0)).toISOString() as Instant;

interface MessageSpec {
  id: string;
  mid?: string;
  inReplyTo?: string[];
  references?: string[];
  subject?: string;
  minute?: number;
}

const message = (spec: MessageSpec): ThreadableMessage => ({
  id: messageId(spec.id),
  messageIdHeader:
    spec.mid === undefined ? [`${spec.id}@example.org`] : spec.mid === "" ? [] : [spec.mid],
  inReplyTo: spec.inReplyTo ?? [],
  references: spec.references ?? [],
  subject: spec.subject ?? "Quarterly numbers",
  receivedAt: at(spec.minute ?? clock++),
  from: [{ name: "", address: `${spec.id}@example.org` }],
  to: [{ name: "", address: "you@example.net" }],
  cc: [],
});

const thread = (messages: ThreadableMessage[]) => threadMessages({ accountId: ACCOUNT, messages });

describe("threading by references", () => {
  it("puts a reply with its parent", () => {
    const threads = thread([
      message({ id: "m1", minute: 0 }),
      message({
        id: "m2",
        inReplyTo: ["m1@example.org"],
        subject: "Re: Quarterly numbers",
        minute: 1,
      }),
    ]);
    expect(threads).toHaveLength(1);
    expect(threads[0]?.messageIds).toEqual(["m1", "m2"]);
    expect(threads[0]?.messageCount).toBe(2);
  });

  it("threads a chain through References", () => {
    const threads = thread([
      message({ id: "m1", minute: 0 }),
      message({ id: "m2", references: ["m1@example.org"], minute: 1 }),
      message({ id: "m3", references: ["m1@example.org", "m2@example.org"], minute: 2 }),
    ]);
    expect(threads).toHaveLength(1);
    expect(threads[0]?.messageIds).toEqual(["m1", "m2", "m3"]);
  });

  it("uses In-Reply-To when References is absent", () => {
    const threads = thread([
      message({ id: "m1", minute: 0 }),
      message({ id: "m2", inReplyTo: ["m1@example.org"], minute: 1 }),
    ]);
    expect(threads).toHaveLength(1);
  });

  it("appends In-Reply-To when References does not already name it", () => {
    const threads = thread([
      message({ id: "m1", minute: 0 }),
      message({
        id: "m2",
        references: ["ancestor@example.org"],
        inReplyTo: ["m1@example.org"],
        minute: 1,
      }),
    ]);
    expect(threads).toHaveLength(1);
    expect(threads[0]?.messageIds).toEqual(["m1", "m2"]);
  });

  it("threads through an ancestor this mailbox never received", () => {
    // References names a message we do not have. The placeholder holds the
    // shape together and must not survive as an empty row.
    const threads = thread([
      message({ id: "m1", references: ["missing@example.org"], minute: 0 }),
      message({ id: "m2", references: ["missing@example.org"], minute: 1 }),
    ]);
    expect(threads).toHaveLength(1);
    expect(threads[0]?.messageIds).toEqual(["m1", "m2"]);
  });

  it("survives a References cycle without hanging", () => {
    const threads = thread([
      message({ id: "m1", references: ["m2@example.org"], minute: 0 }),
      message({ id: "m2", references: ["m1@example.org"], minute: 1 }),
    ]);
    expect(threads.reduce((n, t) => n + t.messageCount, 0)).toBe(2);
  });

  it("threads a message with no Message-ID at all", () => {
    const threads = thread([
      message({ id: "m1", minute: 0 }),
      message({ id: "m2", mid: "", inReplyTo: ["m1@example.org"], minute: 1 }),
    ]);
    expect(threads).toHaveLength(1);
    expect(threads[0]?.messageIds).toEqual(["m1", "m2"]);
  });

  it("never loses a message to a duplicated Message-ID", () => {
    // Two distinct messages sharing an id is malformed input, not permission to
    // drop one of them.
    const threads = thread([
      message({ id: "m1", mid: "shared@example.org", minute: 0 }),
      message({ id: "m2", mid: "shared@example.org", subject: "Something else", minute: 1 }),
    ]);
    const all = threads.flatMap((t) => t.messageIds);
    expect(all.sort()).toEqual(["m1", "m2"]);
  });
});

describe("subject fallback", () => {
  it("joins a reply that carries no References at all", () => {
    const threads = thread([
      message({ id: "m1", subject: "Quarterly numbers", minute: 0 }),
      message({ id: "m2", subject: "RE: Quarterly numbers", minute: 1 }),
    ]);
    expect(threads).toHaveLength(1);
    expect(threads[0]?.messageIds).toEqual(["m1", "m2"]);
  });

  it("does not merge two unrelated messages that share a subject", () => {
    // The failure mode subject grouping is notorious for. Neither is a reply,
    // so there is no evidence of a conversation.
    const threads = thread([
      message({ id: "m1", subject: "Lunch", minute: 0 }),
      message({ id: "m2", subject: "Lunch", minute: 1 }),
    ]);
    expect(threads).toHaveLength(2);
  });

  it("does not merge a forward into the conversation it quotes", () => {
    // "Fwd:" is usually the same text sent to a new audience for a new reason.
    const threads = thread([
      message({ id: "m1", subject: "Quarterly numbers", minute: 0 }),
      message({ id: "m2", subject: "Fwd: Quarterly numbers", minute: 1 }),
    ]);
    expect(threads).toHaveLength(2);
  });

  it("ignores an empty subject rather than grouping every blank one together", () => {
    const threads = thread([
      message({ id: "m1", subject: "", minute: 0 }),
      message({ id: "m2", subject: "  ", minute: 1 }),
    ]);
    expect(threads).toHaveLength(2);
  });

  it("prefers the message without a prefix as the thread root", () => {
    const threads = thread([
      message({ id: "m1", subject: "Re: Numbers", minute: 0 }),
      message({ id: "m2", subject: "Numbers", minute: 1 }),
    ]);
    expect(threads).toHaveLength(1);
    expect(threads[0]?.subject).toBe("Numbers");
  });
});

describe("subject normalisation", () => {
  it("strips repeated prefixes", () => {
    expect(normaliseSubject("Re: Fwd: Re: numbers").base).toBe("numbers");
  });

  it("distinguishes reply from forward", () => {
    expect(normaliseSubject("Re: x")).toMatchObject({ wasReply: true, wasForward: false });
    expect(normaliseSubject("Fwd: x")).toMatchObject({ wasReply: false, wasForward: true });
    expect(normaliseSubject("x")).toMatchObject({ wasReply: false, wasForward: false });
  });

  it("handles the Re[2]: counter convention", () => {
    expect(normaliseSubject("Re[2]: numbers").base).toBe("numbers");
  });

  it("leaves a subject that merely contains a colon alone", () => {
    expect(normaliseSubject("Bug: crash on open")).toMatchObject({
      base: "Bug: crash on open",
      wasReply: false,
    });
  });

  it("collapses whitespace", () => {
    expect(normaliseSubject("  Re:   spaced   out  ").base).toBe("spaced out");
  });

  it("does not strip a list tag", () => {
    expect(normaliseSubject("[devs] Proposal").base).toBe("[devs] Proposal");
  });
});

describe("determinism", () => {
  const messages = [
    message({ id: "m1", minute: 0 }),
    message({ id: "m2", inReplyTo: ["m1@example.org"], minute: 1 }),
    message({ id: "m3", references: ["m1@example.org", "m2@example.org"], minute: 2 }),
    message({ id: "m4", subject: "Unrelated", minute: 3 }),
    message({ id: "m5", subject: "Re: Unrelated", minute: 4 }),
  ];

  it("produces the same result whatever order messages arrive in", () => {
    const forward = thread([...messages]);
    const backward = thread([...messages].reverse());
    const shuffled = thread(
      [messages[2], messages[0], messages[4], messages[1], messages[3]].filter(
        (m): m is ThreadableMessage => m !== undefined,
      ),
    );
    expect(backward).toEqual(forward);
    expect(shuffled).toEqual(forward);
  });

  it("assigns the same thread id on a rebuild", () => {
    // Rebuilding the store must produce byte-identical threads. An id from a
    // counter would change here and every thread would look new.
    expect(thread([...messages]).map((t) => t.id)).toEqual(thread([...messages]).map((t) => t.id));
  });

  it("keeps the thread id stable as replies arrive", () => {
    const before = thread([messages[0]].filter((m): m is ThreadableMessage => m !== undefined));
    const after = thread(messages.slice(0, 3));
    expect(after.find((t) => t.messageIds.includes(messageId("m1")))?.id).toBe(before[0]?.id);
  });

  it("orders threads by most recent activity", () => {
    const threads = thread([...messages]);
    const times = threads.map((t) => t.lastMessageAt);
    expect([...times].sort().reverse()).toEqual(times);
  });
});

describe("thread shape", () => {
  it("collects participants across the whole thread, deduped", () => {
    const threads = thread([
      message({ id: "m1", minute: 0 }),
      message({ id: "m2", inReplyTo: ["m1@example.org"], minute: 1 }),
    ]);
    expect(threads[0]?.participants.map((p) => p.address)).toEqual([
      "m1@example.org",
      "you@example.net",
      "m2@example.org",
    ]);
  });

  it("reports the last message time and count", () => {
    const threads = thread([
      message({ id: "m1", minute: 0 }),
      message({ id: "m2", inReplyTo: ["m1@example.org"], minute: 7 }),
    ]);
    expect(threads[0]?.lastMessageAt).toBe(at(7));
    expect(threads[0]?.messageCount).toBe(2);
  });

  it("strips prefixes from the thread subject", () => {
    const threads = thread([message({ id: "m1", subject: "Re: Quarterly numbers", minute: 0 })]);
    expect(threads[0]?.subject).toBe("Quarterly numbers");
  });

  it("returns nothing for no input", () => {
    expect(thread([])).toEqual([]);
  });
});
