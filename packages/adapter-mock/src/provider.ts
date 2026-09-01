import {
  type Cancellable,
  DaakError,
  ErrorCodes,
  type IntentOutcome,
  type MailProvider,
  type ProviderCapabilities,
  type ProviderChange,
  type ProviderIntent,
  type ProviderMailbox,
  type ProviderMessage,
  type SubmitOutcome,
  type SubmitRequest,
  type SyncCollection,
  accountId as toAccountId,
  type Unsubscribe,
} from "@daak/contracts";
import {
  createFaultEngine,
  type FaultController,
  type FaultKind,
  type ProviderOp,
} from "./faults.js";
import { createRng, type Rng, seedFrom } from "./rng.js";
import { MockServer, type MockServerOptions, toProviderMessage } from "./server.js";

export interface MockProviderOptions extends MockServerOptions {
  accountId?: string;
  /** A string seed is hashed. Same seed, same run — no exceptions. */
  seed?: number | string;
  server?: MockServer;
}

export interface MockProvider extends MailProvider {
  /** Drive and inspect server state directly from tests. */
  readonly server: MockServer;
  readonly faults: FaultController;
  readonly rng: Rng;
}

/**
 * A `MailProvider` that never touches a network.
 *
 * Two jobs. It is the test double every other lane develops against — no
 * credentials, no rate limits, no flakiness. And it is a conformance test for
 * the interface itself: it implements `MailProvider` as specified, so anything
 * it cannot express is a gap in the contract rather than a quirk of a server.
 */
export const createMockProvider = (options: MockProviderOptions = {}): MockProvider => {
  const server = options.server ?? new MockServer(options);
  const rng = createRng(
    typeof options.seed === "string" ? seedFrom(options.seed) : (options.seed ?? 1),
  );
  const faults = createFaultEngine(rng);
  const account = toAccountId(options.accountId ?? "mock-account");

  /** Intent id → the outcome it produced. Replay returns this, unchanged. */
  const settledIntents = new Map<string, IntentOutcome>();
  /** Submission idempotency key → outcome. */
  const settledSubmissions = new Map<string, SubmitOutcome>();
  const watchers = new Set<(collection: SyncCollection) => void>();
  let closed = false;

  const ensureOpen = (): void => {
    if (closed) {
      throw DaakError.permanent(ErrorCodes.UNSUPPORTED, "provider is closed");
    }
  };

  const checkCancelled = (options?: Cancellable): void => {
    if (options?.signal?.aborted === true) {
      throw DaakError.transient(ErrorCodes.TIMEOUT, "cancelled");
    }
  };

  /**
   * Faults that abort before the server does any work. `apply-then-fail` is
   * deliberately absent: it has to mutate first, so each operation that can
   * mutate handles it itself.
   */
  const preflight = (op: ProviderOp, options?: Cancellable): FaultKind | null => {
    ensureOpen();
    checkCancelled(options);
    const fault = faults.take(op);
    switch (fault) {
      case "disconnect":
        throw DaakError.transient(ErrorCodes.NETWORK, "connection reset by peer");
      case "rate-limit":
        throw DaakError.transient(ErrorCodes.RATE_LIMITED, "too many requests", {
          retryAfterMs: 30_000,
        });
      case "expire-cursor":
        throw DaakError.conflict(ErrorCodes.CURSOR_INVALID, "state string is no longer valid");
      default:
        return fault;
    }
  };

  const notify = (collection: SyncCollection): void => {
    for (const watcher of watchers) watcher(collection);
  };

  const applyMutation = (intent: ProviderIntent): IntentOutcome => {
    const { mutation } = intent;
    switch (mutation.kind) {
      case "keywords.change": {
        for (const providerId of mutation.providerIds) {
          server.touch(providerId, (message) => {
            for (const keyword of mutation.add) message.keywords.add(keyword);
            for (const keyword of mutation.remove) message.keywords.delete(keyword);
          });
        }
        return { intentId: intent.intentId, status: "applied", cursor: String(server.state) };
      }
      case "mailboxes.change": {
        for (const providerId of mutation.providerIds) {
          server.touch(providerId, (message) => {
            for (const mailbox of mutation.add) message.mailboxProviderIds.add(mailbox);
            for (const mailbox of mutation.remove) message.mailboxProviderIds.delete(mailbox);
          });
        }
        return { intentId: intent.intentId, status: "applied", cursor: String(server.state) };
      }
      case "message.destroy": {
        for (const providerId of mutation.providerIds) server.destroy(providerId);
        return { intentId: intent.intentId, status: "applied", cursor: String(server.state) };
      }
      case "draft.save": {
        const raw = server.blobs.get(mutation.providerBlobId);
        if (raw === undefined) {
          throw DaakError.permanent(ErrorCodes.NOT_FOUND, "unknown blob for draft");
        }
        if (mutation.replacesProviderId !== undefined) {
          server.destroy(mutation.replacesProviderId);
        }
        const created = server.addMessage({
          raw,
          keywords: ["$draft"],
          mailboxProviderIds: [mutation.mailboxProviderId],
        });
        return {
          intentId: intent.intentId,
          status: "applied",
          cursor: String(server.state),
          createdProviderId: created.providerId,
        };
      }
      case "mailbox.create": {
        const created = server.addMailbox({
          providerId: `MB${server.mailboxes.size + 1}`,
          name: mutation.name,
          parentProviderId: mutation.parentProviderId,
        });
        return {
          intentId: intent.intentId,
          status: "applied",
          cursor: String(server.state),
          createdProviderId: created.providerId,
        };
      }
      case "mailbox.rename": {
        const existing = server.mailboxes.get(mutation.providerId);
        if (existing === undefined) {
          throw DaakError.permanent(ErrorCodes.NOT_FOUND, "unknown mailbox");
        }
        server.mailboxes.set(mutation.providerId, { ...existing, name: mutation.name });
        server.state += 1;
        return { intentId: intent.intentId, status: "applied", cursor: String(server.state) };
      }
      case "mailbox.destroy": {
        if (!server.mailboxes.delete(mutation.providerId)) {
          throw DaakError.permanent(ErrorCodes.NOT_FOUND, "unknown mailbox");
        }
        server.state += 1;
        return { intentId: intent.intentId, status: "applied", cursor: String(server.state) };
      }
    }
  };

  const provider: MockProvider = {
    kind: "mock",
    accountId: account,
    server,
    faults,
    rng,

    async capabilities(): Promise<ProviderCapabilities> {
      ensureOpen();
      return {
        maxObjectsPerFetch: server.maxObjectsPerFetch,
        supportsPush: true,
        supportsIncrementalChanges: true,
        supportsBlobUpload: true,
        maxUploadBytes: 50 * 1024 * 1024,
        quirks: [],
      };
    },

    async listMailboxes(options?: Cancellable): Promise<readonly ProviderMailbox[]> {
      preflight("listMailboxes", options);
      return server.listMailboxes();
    },

    async changes(input) {
      const fault = preflight("changes", input);
      const { messages, hasMore } = server.changesSince(input.cursor, input.limit);

      let page = messages;
      let pageHasMore = hasMore;

      if (fault === "short-batch" && page.length > 1) {
        // Legitimate server behaviour that breaks naive clients: fewer items
        // than asked for, with more still waiting. A client that reads a short
        // batch as "we're done" stalls here and never syncs again.
        page = page.slice(0, page.length - 1);
        pageHasMore = true;
      }

      let changes: ProviderChange[] = page.map((message) => ({
        kind: message.destroyed
          ? ("destroyed" as const)
          : message.createdSeq > (input.cursor === null ? 0 : Number.parseInt(input.cursor, 10))
            ? ("created" as const)
            : ("updated" as const),
        providerId: message.providerId,
      }));

      if (fault === "duplicate-events" && changes.length > 0) {
        const duplicate = changes[rng.int(changes.length)];
        if (duplicate !== undefined) changes = [...changes, duplicate];
      }
      if (fault === "reorder-batch") {
        changes = rng.shuffle(changes);
      }

      // The cursor must never run ahead of what was actually returned, or the
      // skipped changes are lost for good.
      const cursor = String(
        page.at(-1)?.modSeq ?? (input.cursor === null ? server.state : input.cursor),
      );

      return { collection: input.collection, changes, cursor, hasMore: pageHasMore };
    },

    async backfill(input) {
      preflight("backfill", input);
      const page = server.backfillFrom(input.lowWatermark, input.limit);
      return {
        items: page.messages.map((message) => toProviderMessage(message)),
        lowWatermark: page.lowWatermark,
        complete: page.complete,
      };
    },

    async fetchMetadata(
      providerIds: readonly string[],
      options?: Cancellable,
    ): Promise<readonly ProviderMessage[]> {
      const fault = preflight("fetchMetadata", options);
      if (providerIds.length > server.maxObjectsPerFetch) {
        throw DaakError.permanent(
          ErrorCodes.INVALID_INPUT,
          `asked for ${providerIds.length} objects, limit is ${server.maxObjectsPerFetch}`,
          { context: { limit: server.maxObjectsPerFetch } },
        );
      }
      const stale = fault === "stale-read";
      return providerIds
        .filter((providerId) => server.messages.has(providerId))
        .map((providerId) => toProviderMessage(server.require(providerId), stale));
    },

    async fetchRaw(providerId: string, options?: Cancellable): Promise<Uint8Array> {
      preflight("fetchRaw", options);
      const message = server.require(providerId);
      if (message.destroyed) {
        throw DaakError.permanent(ErrorCodes.NOT_FOUND, `message ${providerId} was destroyed`);
      }
      // A copy: nothing outside the server may mutate stored bytes.
      return message.raw.slice();
    },

    async uploadBlob(
      bytes: Uint8Array,
      options?: Cancellable,
    ): Promise<{ providerBlobId: string }> {
      preflight("uploadBlob", options);
      const providerBlobId = `U${server.blobs.size + 1}`;
      server.blobs.set(providerBlobId, bytes.slice());
      return { providerBlobId };
    },

    async apply(
      intents: readonly ProviderIntent[],
      options?: Cancellable,
    ): Promise<readonly IntentOutcome[]> {
      const fault = preflight("apply", options);
      const outcomes: IntentOutcome[] = [];

      for (const intent of intents) {
        const already = settledIntents.get(intent.intentId);
        if (already !== undefined) {
          // Idempotency. A retry after an ambiguous failure lands here and gets
          // the original answer instead of applying the mutation twice.
          outcomes.push(already);
          continue;
        }
        try {
          const outcome = applyMutation(intent);
          settledIntents.set(intent.intentId, outcome);
          outcomes.push(outcome);
        } catch (error) {
          const rejected: IntentOutcome = {
            intentId: intent.intentId,
            status: "rejected",
            error: (error instanceof DaakError
              ? error
              : DaakError.permanent("unknown.unclassified", "failed")
            ).toJSON(),
          };
          settledIntents.set(intent.intentId, rejected);
          outcomes.push(rejected);
        }
      }

      if (intents.length > 0) notify("message");

      if (fault === "apply-then-fail") {
        // The whole point of this package. The mutations above are committed
        // server-side; the caller is about to be told the request failed. An
        // engine that marks these intents `rejected` and rolls back will
        // diverge from the server, and an engine that blindly resends without
        // the idempotency key will apply them twice.
        throw DaakError.transient(ErrorCodes.TIMEOUT, "gateway timeout after commit");
      }

      return outcomes;
    },

    async submit(request: SubmitRequest): Promise<SubmitOutcome> {
      const fault = preflight("submit", request);

      const already = settledSubmissions.get(request.idempotencyKey);
      if (already !== undefined) return already;

      const raw = server.blobs.get(request.providerBlobId);
      if (raw === undefined) {
        throw DaakError.permanent(ErrorCodes.NOT_FOUND, "unknown blob for submission");
      }
      if (request.rcptTo.length === 0) {
        throw DaakError.permanent(ErrorCodes.INVALID_INPUT, "no recipients");
      }

      const sent = server.addMessage({ raw, mailboxProviderIds: ["SENT"], keywords: ["$seen"] });
      const outcome: SubmitOutcome = { status: "accepted", providerId: sent.providerId };
      settledSubmissions.set(request.idempotencyKey, outcome);
      notify("submission");

      if (fault === "apply-then-fail") {
        // Sent, and the sender will never know. Resending without the
        // idempotency key is how a message goes out twice.
        throw DaakError.transient(ErrorCodes.TIMEOUT, "timeout after submission was accepted");
      }

      return outcome;
    },

    watch(onChange: (collection: SyncCollection) => void): Unsubscribe {
      watchers.add(onChange);
      return () => {
        watchers.delete(onChange);
      };
    },

    async close(): Promise<void> {
      closed = true;
      watchers.clear();
    },
  };

  return provider;
};
