import type { AccountId, EventPayload, Instant, MessageId } from "@daak/contracts";
import { accountId, blobIdFromDigest, mailboxId, messageId } from "@daak/contracts";
import { parseMessage } from "@daak/mime";
import { threadMessages } from "@daak/threading";
import { createNodeDriver } from "../src/drivers/node.js";
import type { MessageFields, Projectors } from "../src/projections.js";
import { openStore, type Store } from "../src/store.js";

/**
 * The real projectors, wired from the real packages.
 *
 * `store` cannot import `@daak/mime` or `@daak/threading` — its dependency list
 * is contracts plus a driver, and that boundary is what keeps each package
 * testable without the others. So the wiring lives here, in tests, exactly as it
 * will live in `@daak/sync` in production.
 */
export const realProjectors: Projectors = {
  async resolveMessage(raw): Promise<MessageFields> {
    const parsed = await parseMessage(raw);
    return {
      ...parsed.envelope,
      hasAttachment: parsed.hasAttachment,
      preview: parsed.preview,
    };
  },
  threadMessages: (input) => threadMessages(input),
};

/** A projector that does no parsing, for tests about the store itself. */
export const stubProjectors: Projectors = {
  async resolveMessage(raw): Promise<MessageFields> {
    const text = new TextDecoder().decode(raw);
    const subject = /^Subject:\s*(.*)$/m.exec(text)?.[1]?.trim() ?? "";
    const mid = /^Message-ID:\s*<?([^>\r\n]*)>?$/m.exec(text)?.[1]?.trim();
    return {
      subject,
      from: [],
      to: [],
      cc: [],
      bcc: [],
      replyTo: [],
      messageIdHeader: mid === undefined || mid === "" ? [] : [mid],
      inReplyTo: [],
      references: [],
      listId: undefined,
      sentAt: undefined,
      hasAttachment: false,
      preview: text.split("\n\n")[1]?.trim().slice(0, 64) ?? "",
    };
  },
  threadMessages: ({ accountId: account, messages }) =>
    messages.map((message) => ({
      id: `t:${message.id}` as never,
      accountId: account,
      messageIds: [message.id],
      subject: message.subject,
      participants: [],
      lastMessageAt: message.receivedAt,
      messageCount: 1,
    })),
};

export const ACCOUNT: AccountId = accountId("acct");
export const INBOX = mailboxId("mb-inbox");
export const ARCHIVE = mailboxId("mb-archive");

export const makeStore = (projectors: Projectors = stubProjectors): Store => {
  const store = openStore({ driver: createNodeDriver(), projectors });
  store.migrate();
  return store;
};

export const at = (minute: number): Instant =>
  new Date(Date.UTC(2026, 7, 1, 0, minute, 0)).toISOString() as Instant;

export const rawMessage = (
  id: string,
  subject = "Quarterly numbers",
  body = "Body text.",
): Uint8Array =>
  new TextEncoder().encode(
    `Message-ID: <${id}@example.org>\r\nFrom: Asha <asha@example.org>\r\nTo: you@example.net\r\nSubject: ${subject}\r\nDate: Mon, 3 Aug 2026 09:14:22 +0000\r\nContent-Type: text/plain; charset=us-ascii\r\n\r\n${body}\r\n`,
  );

/**
 * Store a message and log the events a sync would have produced.
 *
 * Deliberately the long way round: nothing writes a projection directly, so a
 * test that sets up state through this helper is exercising the same path
 * production uses.
 */
export const observeMessage = async (
  store: Store,
  options: {
    id: string;
    subject?: string;
    body?: string;
    minute?: number;
    keywords?: string[];
    mailboxes?: string[];
  },
): Promise<MessageId> => {
  const raw = rawMessage(options.id, options.subject, options.body);
  const { id: blobId } = await store.blobs.put(raw);
  const id = messageId(options.id);
  const at_ = at(options.minute ?? 0);

  const payloads: EventPayload[] = [
    { type: "blob.stored", blobId, size: raw.byteLength },
    {
      type: "message.observed",
      messageId: id,
      blobId,
      providerId: `P-${options.id}`,
      receivedAt: at_,
    },
    { type: "message.keywords.set", messageId: id, keywords: options.keywords ?? [] },
    {
      type: "message.mailboxes.set",
      messageId: id,
      mailboxIds: (options.mailboxes ?? [INBOX]) as never,
    },
  ];

  const events = store.events.appendMany(
    payloads.map((payload) => ({
      accountId: ACCOUNT,
      source: "remote" as const,
      payload,
      at: at_,
    })),
  );
  await store.projector.apply(events, (blob) => store.blobs.get(blob as never));
  return id;
};

export const digestOf = (hex: string) => blobIdFromDigest(hex.padEnd(64, "0"));
