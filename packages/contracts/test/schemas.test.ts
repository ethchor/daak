import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { BlobIdSchema, blobIdFromDigest, CommandIdSchema } from "../src/ids.js";
import {
  AnnotationSchema,
  EventSchema,
  IntentSchema,
  MailboxSchema,
  MessageSchema,
  normaliseKeywords,
  ThreadSchema,
} from "../src/index.js";
import { InstantSchema, JsonValueSchema } from "../src/primitives.js";

const AT = "2026-08-31T09:15:00.000Z";

const message = {
  id: "m1",
  accountId: "a1",
  blobId: blobIdFromDigest("a".repeat(64)),
  threadId: "t1",
  providerId: "Md45",
  mailboxIds: ["mb1"],
  keywords: ["$seen"],
  receivedAt: AT,
  from: [{ name: "Asha", address: "asha@example.org" }],
  to: [{ name: "", address: "you@example.org" }],
  cc: [],
  bcc: [],
  replyTo: [],
  subject: "Quarterly numbers",
  messageIdHeader: ["abc@example.org"],
  inReplyTo: [],
  references: [],
  size: 4096,
  hasAttachment: false,
  preview: "Numbers attached.",
};

describe("persisted shapes", () => {
  it("parses a representative message", () => {
    const parsed = MessageSchema.parse(message);
    expect(parsed.subject).toBe("Quarterly numbers");
    expect(parsed.sentAt).toBeUndefined();
  });

  it("accepts mail that real mailboxes actually contain", () => {
    // No Date header, empty subject, a display name with no address, a
    // malformed addr-spec. All of this exists; none of it may fail to parse.
    const ugly = MessageSchema.parse({
      ...message,
      subject: "",
      from: [{ name: "no address at all", address: "" }],
      to: [{ address: "not an email" }],
    });
    expect(ugly.to[0]?.name).toBe("");
  });

  it("rejects a blob id that is not a sha-256 content address", () => {
    expect(() => BlobIdSchema.parse("blob-42")).toThrow();
    expect(() => BlobIdSchema.parse("sha256:XYZ")).toThrow();
    expect(() => BlobIdSchema.parse(`sha256:${"A".repeat(64)}`)).toThrow(); // uppercase hex
    expect(BlobIdSchema.parse(`sha256:${"0".repeat(64)}`)).toBeDefined();
  });

  it("enforces the dotted command id convention", () => {
    expect(CommandIdSchema.parse("mail.archive")).toBe("mail.archive");
    expect(CommandIdSchema.parse("thread.mark-read")).toBe("thread.mark-read");
    expect(() => CommandIdSchema.parse("Archive")).toThrow();
    expect(() => CommandIdSchema.parse("archive")).toThrow();
  });

  it("requires instants to be UTC ISO strings", () => {
    expect(InstantSchema.parse(AT)).toBe(AT);
    expect(() => InstantSchema.parse("2026-08-31T09:15:00+05:30")).toThrow();
    expect(() => InstantSchema.parse("31 Aug 2026")).toThrow();
  });

  it("parses mailboxes, threads and annotations", () => {
    expect(
      MailboxSchema.parse({
        id: "mb1",
        accountId: "a1",
        providerId: "INBOX",
        name: "Inbox",
        parentId: null,
        role: "inbox",
      }).sortOrder,
    ).toBe(0);

    expect(
      ThreadSchema.parse({
        id: "t1",
        accountId: "a1",
        messageIds: ["m1"],
        subject: "Quarterly numbers",
        participants: [{ name: "Asha", address: "asha@example.org" }],
        lastMessageAt: AT,
        messageCount: 1,
      }).messageCount,
    ).toBe(1);

    const annotation = AnnotationSchema.parse({
      id: "an1",
      accountId: "a1",
      subject: { kind: "message", id: "m1" },
      namespace: "triage",
      key: "priority",
      value: { level: "high", reasons: ["mentions a deadline"] },
      producer: "daak.triage",
      producerVersion: 1,
      createdAt: AT,
    });
    expect(annotation.subject.kind).toBe("message");
  });
});

describe("event log", () => {
  it("carries only what replay needs — no derived fields", () => {
    const event = EventSchema.parse({
      seq: 7,
      accountId: "a1",
      at: AT,
      source: "remote",
      payload: {
        type: "message.observed",
        messageId: "m1",
        blobId: blobIdFromDigest("b".repeat(64)),
        providerId: "Md45",
        receivedAt: AT,
      },
    });
    expect(event.payload.type).toBe("message.observed");
    // Subject/preview are derived from the blob and must not be in an event.
    expect(Object.keys(event.payload)).not.toContain("subject");
  });

  it("states keyword and mailbox changes absolutely, never as deltas", () => {
    const parsed = EventSchema.parse({
      seq: 8,
      accountId: "a1",
      at: AT,
      source: "local",
      payload: { type: "message.keywords.set", messageId: "m1", keywords: ["$seen", "$flagged"] },
    });
    expect(parsed.payload).toMatchObject({ keywords: ["$seen", "$flagged"] });
  });

  it("rejects an unknown event type instead of storing something unreplayable", () => {
    expect(() =>
      EventSchema.parse({
        seq: 9,
        accountId: "a1",
        at: AT,
        source: "remote",
        payload: { type: "message.vibed", messageId: "m1" },
      }),
    ).toThrow();
  });
});

describe("intents", () => {
  it("defaults a fresh intent to pending with no attempts", () => {
    const intent = IntentSchema.parse({
      id: "i1",
      accountId: "a1",
      createdAt: AT,
      op: { op: "keywords.change", messageIds: ["m1"], add: ["$seen"] },
      state: "pending",
    });
    expect(intent.attempts).toBe(0);
    expect(intent.op).toMatchObject({ add: ["$seen"], remove: [] });
  });

  it("models the ambiguous outcome as a first-class state", () => {
    // The bug this exists to prevent: a request that timed out but succeeded
    // server-side. It is not `settled` and it is not `rejected`.
    const intent = IntentSchema.parse({
      id: "i2",
      accountId: "a1",
      createdAt: AT,
      op: { op: "message.destroy", messageIds: ["m1"] },
      state: "unknown",
      attempts: 1,
    });
    expect(intent.state).toBe("unknown");
  });

  it("refuses an empty target set", () => {
    expect(() =>
      IntentSchema.parse({
        id: "i3",
        accountId: "a1",
        createdAt: AT,
        op: { op: "keywords.change", messageIds: [], add: ["$seen"] },
        state: "pending",
      }),
    ).toThrow();
  });
});

describe("keyword normalisation", () => {
  it("is idempotent, order-independent and deduplicating", () => {
    fc.assert(
      fc.property(fc.array(fc.string({ minLength: 1, maxLength: 12 })), (keywords) => {
        const once = normaliseKeywords(keywords);
        expect(normaliseKeywords(once)).toEqual(once);
        expect(normaliseKeywords([...keywords].reverse())).toEqual(once);
        expect(new Set(once).size).toBe(once.length);
      }),
    );
  });
});

describe("JsonValue", () => {
  it("accepts arbitrary nested JSON and rejects what JSON cannot hold", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        expect(() => JsonValueSchema.parse(value)).not.toThrow();
      }),
    );
    expect(() => JsonValueSchema.parse(undefined)).toThrow();
    expect(() => JsonValueSchema.parse(new Date())).toThrow();
  });

  it("is the type annotations are stored as", () => {
    expect(z.safeParse(JsonValueSchema, { a: [1, "two", null, { b: true }] }).success).toBe(true);
  });
});
