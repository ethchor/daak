import type { AccountId, EventPayload, Instant, MailboxId } from "@daak/contracts";
import { mailboxId, accountId as makeAccountId, messageId } from "@daak/contracts";
import { type ParsedMessage, parseMessage } from "@daak/mime";
import { createSearchIndex, type SearchDocument } from "@daak/search";
import {
  createNodeDriver,
  type MessageFields,
  openStore,
  type Projectors,
  type Store,
} from "@daak/store";
import { threadMessages } from "@daak/threading";
import { type GeneratedMessage, generate, plannedTotal } from "./generate.js";
import type { Population } from "./population.js";

export const SEED_ACCOUNT: AccountId = makeAccountId("seed");

const toFields = (parsed: ParsedMessage): MessageFields => ({
  ...parsed.envelope,
  hasAttachment: parsed.hasAttachment,
  preview: parsed.preview,
});

/**
 * The real projectors, wired the way `@daak/sync` wires them in production.
 *
 * `@daak/store` may not import `@daak/mime` or `@daak/threading` — that
 * boundary is what keeps each testable without the others — so the wiring
 * happens at the edge. Doing it here rather than stubbing it is the point: a
 * seeded mailbox exists to measure the real parse and the real threading, and
 * a stub would make every number meaningless.
 */
export const realProjectors: Projectors = {
  async resolveMessage(raw): Promise<MessageFields> {
    return toFields(await parseMessage(raw));
  },
  threadMessages: (input) => threadMessages(input),
};

/**
 * Projectors that hand back a parse the caller can reuse.
 *
 * Seeding needs each message parsed twice — once for the message row, once for
 * the full-text document — and parsing is by a wide margin the most expensive
 * thing seeding does. Caching on the byte array itself works because the
 * seeder controls `readBlob` and hands the projector the very buffer it
 * generated, so the two lookups are the same object. A `WeakMap` means a batch
 * that goes out of scope takes its parses with it, which is what keeps a 500k
 * run inside a sane heap.
 */
const createCachingProjectors = (): {
  projectors: Projectors;
  parse: (raw: Uint8Array) => Promise<ParsedMessage>;
} => {
  const cache = new WeakMap<Uint8Array, Promise<ParsedMessage>>();
  const parse = (raw: Uint8Array): Promise<ParsedMessage> => {
    const existing = cache.get(raw);
    if (existing !== undefined) return existing;
    const pending = parseMessage(raw);
    cache.set(raw, pending);
    return pending;
  };
  return {
    parse,
    projectors: {
      async resolveMessage(raw): Promise<MessageFields> {
        return toFields(await parse(raw));
      },
      threadMessages: (input) => threadMessages(input),
    },
  };
};

export interface SeedOptions {
  readonly population: Population;
  /**
   * Where the database goes. Omitted means in-memory, which is what the tests
   * use and is not what a 500k run should do.
   */
  readonly location?: string | undefined;
  /**
   * Messages per projection batch.
   *
   * This is the knob that matters most for seeding time, and not for the
   * reason it looks. Threads are recomputed for the whole account once per
   * `apply` call, so a small batch means recomputing the whole mailbox
   * hundreds of times. Larger is dramatically faster to seed — and less like
   * production, where batches are small and that cost is real. `bench.ts`
   * measures it directly rather than letting the seeder hide it.
   */
  readonly batchSize?: number | undefined;
  /** Build the full-text index as we go. Off makes seeding measurably faster. */
  readonly index?: boolean | undefined;
  readonly onProgress?: ((done: number, total: number) => void) | undefined;
}

export interface SeedResult {
  readonly store: Store;
  readonly accountId: AccountId;
  readonly messages: number;
  readonly mailboxes: readonly MailboxId[];
  /** Wall-clock milliseconds, split so a slow seed can be attributed. */
  readonly timings: {
    readonly total: number;
    readonly blobs: number;
    readonly project: number;
    readonly index: number;
  };
}

export const seedMailboxId = (name: string): MailboxId => mailboxId(`mb-${name.toLowerCase()}`);

const displayNames = (
  people: readonly { readonly name?: string | undefined; readonly address: string }[],
): string => people.map((person) => `${person.name ?? ""} ${person.address}`.trim()).join(" ");

const toSearchDocument = (
  parsed: ParsedMessage,
  id: ReturnType<typeof messageId>,
): SearchDocument => ({
  messageId: id,
  accountId: SEED_ACCOUNT,
  subject: parsed.envelope.subject,
  sender: displayNames(parsed.envelope.from),
  recipients: `${displayNames(parsed.envelope.to)} ${displayNames(parsed.envelope.cc)}`.trim(),
  // The text body only. Indexing HTML source would put every tag name in the
  // index and make `div` one of the commonest terms in the mailbox.
  body: parsed.text ?? "",
});

/**
 * Fill a store from a generated population.
 *
 * Everything goes in through the event log, exactly as a sync would write it.
 * Writing projections directly would seed faster and would measure a code path
 * that does not exist.
 */
export const seedStore = async (options: SeedOptions): Promise<SeedResult> => {
  const started = Date.now();
  const { projectors, parse } = createCachingProjectors();
  const driver = createNodeDriver(
    options.location === undefined ? {} : { location: options.location },
  );
  const store = openStore({ driver, projectors });
  store.migrate();

  const searchIndex = options.index === false ? undefined : createSearchIndex(store);
  const batchSize = options.batchSize ?? 5_000;
  const total = plannedTotal(options.population);
  const now = new Date().toISOString() as Instant;

  const mailboxes = options.population.mailboxes.map((mailbox, index) => ({
    id: seedMailboxId(mailbox.name),
    payload: {
      type: "mailbox.upserted",
      mailbox: {
        id: seedMailboxId(mailbox.name),
        accountId: SEED_ACCOUNT,
        providerId: `p-${mailbox.name}`,
        name: mailbox.name,
        parentId: null,
        role: mailbox.role,
        sortOrder: index,
      },
    } satisfies EventPayload,
  }));

  const mailboxEvents = store.events.appendMany(
    mailboxes.map(({ payload }) => ({
      accountId: SEED_ACCOUNT,
      source: "remote" as const,
      at: now,
      payload,
    })),
  );
  await store.projector.apply(mailboxEvents, (id) => store.blobs.get(id as never));

  let blobMs = 0;
  let projectMs = 0;
  let indexMs = 0;
  let done = 0;
  let batch: GeneratedMessage[] = [];

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;

    const blobStart = Date.now();
    const payloads: EventPayload[] = [];
    /** blobId -> the buffer we already hold, so the projector reuses our parse. */
    const inBatch = new Map<string, Uint8Array>();
    const ids: { id: ReturnType<typeof messageId>; raw: Uint8Array }[] = [];

    for (const message of batch) {
      const { id: blobId } = await store.blobs.put(message.raw);
      const id = messageId(message.providerId);
      inBatch.set(blobId, message.raw);
      ids.push({ id, raw: message.raw });
      payloads.push({ type: "blob.stored", blobId, size: message.raw.byteLength });
      payloads.push({
        type: "message.observed",
        messageId: id,
        blobId,
        providerId: message.providerId,
        receivedAt: message.receivedAt,
      });
      payloads.push({
        type: "message.keywords.set",
        messageId: id,
        keywords: [...message.keywords],
      });
      payloads.push({
        type: "message.mailboxes.set",
        messageId: id,
        mailboxIds: [seedMailboxId(message.mailbox)],
      });
    }
    blobMs += Date.now() - blobStart;

    const projectStart = Date.now();
    const events = store.events.appendMany(
      payloads.map((payload) => ({
        accountId: SEED_ACCOUNT,
        source: "remote" as const,
        at: now,
        payload,
      })),
    );
    await store.projector.apply(
      events,
      async (id) => inBatch.get(id) ?? store.blobs.get(id as never),
    );
    projectMs += Date.now() - projectStart;

    if (searchIndex !== undefined) {
      const indexStart = Date.now();
      const documents: SearchDocument[] = [];
      for (const { id, raw } of ids) documents.push(toSearchDocument(await parse(raw), id));
      searchIndex.index(documents);
      indexMs += Date.now() - indexStart;
    }

    done += batch.length;
    options.onProgress?.(done, total);
    batch = [];
  };

  for (const message of generate(options.population)) {
    batch.push(message);
    if (batch.length >= batchSize) await flush();
  }
  await flush();

  return {
    store,
    accountId: SEED_ACCOUNT,
    messages: store.countMessages(SEED_ACCOUNT),
    mailboxes: mailboxes.map(({ id }) => id),
    timings: { total: Date.now() - started, blobs: blobMs, project: projectMs, index: indexMs },
  };
};
