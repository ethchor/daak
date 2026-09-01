import {
  DaakError,
  ErrorCodes,
  type MailboxRole,
  type ProviderMailbox,
  type ProviderMessage,
} from "@daak/contracts";

/**
 * A deterministic in-memory mail server.
 *
 * Everything the provider does reads or mutates this. Tests drive it directly
 * to set up state and to assert the outcome, which is what makes an assertion
 * about convergence meaningful: local state is compared against what the server
 * actually holds, not against what the client believes it holds.
 *
 * ## Model
 *
 * State is a single monotonic counter, `state`. Every mutation increments it
 * and stamps the affected message. A cursor is just that number as a string —
 * which is a fair model of JMAP state strings, and lets `changes()` be a scan
 * for `modSeq > cursor`.
 *
 * Deleted messages leave tombstones. A server that forgets a deletion cannot
 * report it, and a client that never hears about it keeps the message forever.
 */
export interface ServerMessage {
  providerId: string;
  raw: Uint8Array;
  providerBlobId: string;
  size: number;
  receivedAt: string;
  keywords: Set<string>;
  mailboxProviderIds: Set<string>;
  /** State counter when the message first appeared. Distinguishes created from updated. */
  createdSeq: number;
  modSeq: number;
  destroyed: boolean;
  /** State before the most recent mutation, so `stale-read` can be faithful. */
  previous: { keywords: Set<string>; mailboxProviderIds: Set<string> } | null;
}

export interface AddMessageInput {
  raw: Uint8Array | string;
  providerId?: string;
  receivedAt?: string;
  keywords?: readonly string[];
  mailboxProviderIds?: readonly string[];
}

export interface MockServerOptions {
  /**
   * How many state steps of change history the server keeps. A cursor older
   * than this is rejected and the client must resynchronise — real servers all
   * do this, and clients that assume otherwise break after a long offline
   * period. Unlimited by default so tests opt in.
   */
  historyWindow?: number;
  maxObjectsPerFetch?: number;
}

const DEFAULT_MAILBOXES: readonly { providerId: string; name: string; role: MailboxRole }[] = [
  { providerId: "INBOX", name: "Inbox", role: "inbox" },
  { providerId: "ARCHIVE", name: "Archive", role: "archive" },
  { providerId: "DRAFTS", name: "Drafts", role: "drafts" },
  { providerId: "SENT", name: "Sent", role: "sent" },
  { providerId: "TRASH", name: "Trash", role: "trash" },
  { providerId: "JUNK", name: "Junk", role: "junk" },
];

export class MockServer {
  /** Monotonic. Every mutation bumps it exactly once. */
  state = 0;

  readonly messages = new Map<string, ServerMessage>();
  readonly mailboxes = new Map<string, ProviderMailbox>();
  readonly blobs = new Map<string, Uint8Array>();

  readonly historyWindow: number;
  readonly maxObjectsPerFetch: number;

  private nextId = 1;

  constructor(options: MockServerOptions = {}) {
    this.historyWindow = options.historyWindow ?? Number.POSITIVE_INFINITY;
    this.maxObjectsPerFetch = options.maxObjectsPerFetch ?? 500;

    for (const [index, mailbox] of DEFAULT_MAILBOXES.entries()) {
      this.mailboxes.set(mailbox.providerId, {
        providerId: mailbox.providerId,
        name: mailbox.name,
        parentProviderId: null,
        role: mailbox.role,
        sortOrder: index,
      });
    }
  }

  // ---------------------------------------------------------------- mutation

  addMailbox(input: {
    providerId: string;
    name: string;
    role?: MailboxRole;
    parentProviderId?: string | null;
  }): ProviderMailbox {
    const mailbox: ProviderMailbox = {
      providerId: input.providerId,
      name: input.name,
      parentProviderId: input.parentProviderId ?? null,
      role: input.role ?? "none",
      sortOrder: this.mailboxes.size,
    };
    this.mailboxes.set(mailbox.providerId, mailbox);
    this.state += 1;
    return mailbox;
  }

  addMessage(input: AddMessageInput): ServerMessage {
    const raw = typeof input.raw === "string" ? new TextEncoder().encode(input.raw) : input.raw;
    const providerId = input.providerId ?? `M${this.nextId++}`;
    if (this.messages.has(providerId)) {
      throw DaakError.permanent(ErrorCodes.INVALID_INPUT, `duplicate providerId ${providerId}`);
    }

    this.state += 1;
    const providerBlobId = `B${providerId}`;
    this.blobs.set(providerBlobId, raw);

    const message: ServerMessage = {
      providerId,
      raw,
      providerBlobId,
      size: raw.byteLength,
      // Deterministic default: derived from the id, never from the clock.
      receivedAt: input.receivedAt ?? syntheticReceivedAt(this.state),
      keywords: new Set(input.keywords ?? []),
      mailboxProviderIds: new Set(input.mailboxProviderIds ?? ["INBOX"]),
      createdSeq: this.state,
      modSeq: this.state,
      destroyed: false,
      previous: null,
    };
    this.messages.set(providerId, message);
    return message;
  }

  /** Apply a change and stamp it, keeping the prior state for `stale-read`. */
  touch(providerId: string, mutate: (message: ServerMessage) => void): ServerMessage {
    const message = this.require(providerId);
    message.previous = {
      keywords: new Set(message.keywords),
      mailboxProviderIds: new Set(message.mailboxProviderIds),
    };
    mutate(message);
    this.state += 1;
    message.modSeq = this.state;
    return message;
  }

  destroy(providerId: string): void {
    this.touch(providerId, (message) => {
      message.destroyed = true;
      message.keywords.clear();
      message.mailboxProviderIds.clear();
    });
  }

  // ------------------------------------------------------------------- reads

  require(providerId: string): ServerMessage {
    const message = this.messages.get(providerId);
    if (message === undefined) {
      throw DaakError.permanent(ErrorCodes.NOT_FOUND, `no message ${providerId}`);
    }
    return message;
  }

  /**
   * Changes since `cursor`, oldest first.
   *
   * Throws `conflict` / `sync.cursor_invalid` when the cursor has fallen out of
   * the history window. The engine's correct response is a full resynchronise;
   * treating it as permanent strands the account.
   */
  changesSince(
    cursor: string | null,
    limit: number,
  ): { messages: ServerMessage[]; hasMore: boolean } {
    const since = cursor === null ? 0 : Number.parseInt(cursor, 10);
    if (Number.isNaN(since) || since < 0 || since > this.state) {
      throw DaakError.conflict(ErrorCodes.CURSOR_INVALID, `unusable cursor ${cursor}`);
    }
    if (this.state - since > this.historyWindow) {
      throw DaakError.conflict(ErrorCodes.CURSOR_INVALID, "cursor older than history window", {
        context: { historyWindow: this.historyWindow },
      });
    }

    const changed = [...this.messages.values()]
      .filter((message) => message.modSeq > since)
      .sort((a, b) => a.modSeq - b.modSeq);

    return { messages: changed.slice(0, limit), hasMore: changed.length > limit };
  }

  /** History, newest first, walking downwards from `lowWatermark`. */
  backfillFrom(
    lowWatermark: string | null,
    limit: number,
  ): { messages: ServerMessage[]; lowWatermark: string | null; complete: boolean } {
    const ordered = [...this.messages.values()]
      .filter((message) => !message.destroyed)
      .sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : a.receivedAt > b.receivedAt ? -1 : 0));

    const startIndex =
      lowWatermark === null ? 0 : ordered.findIndex((m) => m.providerId === lowWatermark) + 1;
    const page = ordered.slice(startIndex, startIndex + limit);
    const complete = startIndex + page.length >= ordered.length;

    return {
      messages: page,
      lowWatermark: page.at(-1)?.providerId ?? lowWatermark,
      complete,
    };
  }

  listMailboxes(): ProviderMailbox[] {
    return [...this.mailboxes.values()].sort((a, b) => a.sortOrder - b.sortOrder);
  }

  /**
   * A comparable view of everything the server holds.
   *
   * This is what a convergence assertion compares against — "local state
   * matches the server" has to mean the server's actual state, not a second
   * copy of the client's belief about it.
   */
  snapshot(): Record<string, { keywords: string[]; mailboxes: string[]; destroyed: boolean }> {
    const result: Record<string, { keywords: string[]; mailboxes: string[]; destroyed: boolean }> =
      {};
    for (const [providerId, message] of [...this.messages].sort(([a], [b]) => (a < b ? -1 : 1))) {
      result[providerId] = {
        keywords: [...message.keywords].sort(),
        mailboxes: [...message.mailboxProviderIds].sort(),
        destroyed: message.destroyed,
      };
    }
    return result;
  }
}

/** Provider metadata view of a server message, honouring a stale read. */
export const toProviderMessage = (message: ServerMessage, stale = false): ProviderMessage => {
  const view = stale && message.previous !== null ? message.previous : message;
  return {
    providerId: message.providerId,
    providerBlobId: message.destroyed ? null : message.providerBlobId,
    size: message.size,
    receivedAt: message.receivedAt,
    keywords: [...view.keywords].sort(),
    mailboxProviderIds: [...view.mailboxProviderIds].sort(),
  };
};

/**
 * Received timestamps derived from the state counter, not the clock. Tests that
 * depend on wall-clock time fail on a slow machine and pass on a fast one.
 */
const syntheticReceivedAt = (step: number): string =>
  new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + step * 60_000).toISOString();
