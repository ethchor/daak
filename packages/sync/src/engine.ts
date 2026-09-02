import {
  type Cancellable,
  DaakError,
  ErrorCodes,
  type EventPayload,
  type Instant,
  type Intent,
  type IntentOp,
  type IntentOutcome,
  isDaakError,
  type MailboxId,
  type MessageId,
  nowInstant,
  type ProviderIntent,
  type ProviderMessage,
  type ProviderMutation,
  type SyncStatus,
  toDaakError,
  intentId as toIntentId,
} from "@daak/contracts";
import { localMailboxId, localMessageId, providerIdOf } from "./ids.js";
import type {
  BackfillResult,
  PushResult,
  SettleResult,
  SyncEngine,
  SyncEngineOptions,
  TailResult,
} from "./types.js";

const COLLECTION = "message" as const;

export const createSyncEngine = (options: SyncEngineOptions): SyncEngine => {
  const { accountId, provider, store } = options;
  const now = options.now ?? nowInstant;
  const pageSize = options.pageSize ?? 50;

  let phase: SyncStatus["phase"] = "idle";
  let lastErrorCode: string | undefined;
  let lastSyncedAt: Instant | undefined;
  let intentCounter = 0;

  /**
   * What the server must show us before we believe a read about a message we
   * changed ourselves.
   *
   * Three attempts at this, and the first two were wrong in instructive ways.
   *
   * 1. Trust the change feed. It reports the message while a read is still
   *    stale; we store the stale state and advance the cursor past the change,
   *    which is then invisible for ever.
   * 2. Believe a read once a second read agrees. A server that serves three
   *    stale reads in a row produces two stale reads that agree with each
   *    other. Repetition is not evidence.
   * 3. This one. We know what we asked for, so a read that contradicts an
   *    applied change is discarded as stale — on *every* path, not just during
   *    verification. That last part is what the second attempt missed: the
   *    verification refresh read fresh data and cleared itself, and then the
   *    tail's own fetch came back stale and overwrote it.
   *
   * A guard therefore filters writes rather than merely prompting re-reads, and
   * it outlives the first conforming read. `budget` ends the argument: after
   * enough contradicting reads we accept the server, because a stale read and
   * another client genuinely undoing the change are indistinguishable from
   * here, and the server is the authority.
   *
   * Only `applied` needs a guard:
   *   - `rejected` means the server never changed, so even a stale read
   *     returns the correct state.
   *   - `unknown` leaves the intent outstanding, so it is re-sent under the
   *     same id and resolves to applied or rejected.
   */
  interface Expectation {
    keywordsPresent: Set<string>;
    keywordsAbsent: Set<string>;
    mailboxesPresent: Set<string>;
    mailboxesAbsent: Set<string>;
  }

  interface Guard {
    expect: Expectation;
    /** A conforming read has been seen; stop forcing refreshes. */
    satisfied: boolean;
    /** Reads left before we stop arguing and take the server's word. */
    budget: number;
  }

  const READ_BUDGET = 8;
  const guards = new Map<string, Guard>();
  /** Messages to re-read once, with nothing specific expected of them. */
  const needsRead = new Set<string>();

  const emptyExpectation = (): Expectation => ({
    keywordsPresent: new Set(),
    keywordsAbsent: new Set(),
    mailboxesPresent: new Set(),
    mailboxesAbsent: new Set(),
  });

  /** What the server must show once this intent has been applied. */
  const expectationOf = (intent: Intent): Expectation | null => {
    const op = intent.op;
    if (op.op === "keywords.change") {
      const expect = emptyExpectation();
      for (const keyword of op.add) expect.keywordsPresent.add(keyword);
      for (const keyword of op.remove) expect.keywordsAbsent.add(keyword);
      return expect;
    }
    if (op.op === "mailboxes.change") {
      const expect = emptyExpectation();
      for (const mailbox of op.add) expect.mailboxesPresent.add(providerIdOf(mailbox));
      for (const mailbox of op.remove) expect.mailboxesAbsent.add(providerIdOf(mailbox));
      return expect;
    }
    // A destroy is confirmed by the message being gone, which `refresh` detects
    // without needing an expectation.
    return null;
  };

  const expect = (providerIds: readonly string[], expectation: Expectation | null): void => {
    for (const providerId of providerIds) {
      if (providerId === "") continue;
      if (expectation === null) {
        needsRead.add(providerId);
        continue;
      }
      const existing = guards.get(providerId);
      if (existing === undefined) {
        guards.set(providerId, { expect: expectation, satisfied: false, budget: READ_BUDGET });
        continue;
      }
      // A later mutation overrides an earlier one on the same value: adding a
      // keyword after removing it means present, not both.
      const merged = existing.expect;
      for (const value of expectation.keywordsPresent) {
        merged.keywordsAbsent.delete(value);
        merged.keywordsPresent.add(value);
      }
      for (const value of expectation.keywordsAbsent) {
        merged.keywordsPresent.delete(value);
        merged.keywordsAbsent.add(value);
      }
      for (const value of expectation.mailboxesPresent) {
        merged.mailboxesAbsent.delete(value);
        merged.mailboxesPresent.add(value);
      }
      for (const value of expectation.mailboxesAbsent) {
        merged.mailboxesPresent.delete(value);
        merged.mailboxesAbsent.add(value);
      }
      // The expectation changed, so a previously conforming read proves nothing.
      guards.set(providerId, { expect: merged, satisfied: false, budget: READ_BUDGET });
    }
  };

  const satisfies = (meta: ProviderMessage, expectation: Expectation): boolean => {
    const keywords = new Set(meta.keywords);
    const mailboxes = new Set(meta.mailboxProviderIds);
    for (const value of expectation.keywordsPresent) if (!keywords.has(value)) return false;
    for (const value of expectation.keywordsAbsent) if (keywords.has(value)) return false;
    for (const value of expectation.mailboxesPresent) if (!mailboxes.has(value)) return false;
    for (const value of expectation.mailboxesAbsent) if (mailboxes.has(value)) return false;
    return true;
  };

  /**
   * Decide whether to believe a read, and age its guard.
   *
   * Returns false when the read contradicts a live expectation — the caller
   * must then discard it rather than writing it, because writing it is exactly
   * how a change becomes invisible.
   */
  const believable = (meta: ProviderMessage): boolean => {
    needsRead.delete(meta.providerId);
    const guard = guards.get(meta.providerId);
    if (guard === undefined) return true;

    const ok = satisfies(meta, guard.expect);
    const budget = guard.budget - 1;
    if (ok) {
      if (budget <= 0) guards.delete(meta.providerId);
      else guards.set(meta.providerId, { ...guard, satisfied: true, budget });
      return true;
    }
    if (budget <= 0) {
      // Out of patience. Another client may simply have undone this.
      guards.delete(meta.providerId);
      return true;
    }
    guards.set(meta.providerId, { ...guard, budget });
    return false;
  };

  const unsettled = (): string[] => [
    ...new Set([
      ...needsRead,
      ...[...guards.entries()].filter(([, guard]) => !guard.satisfied).map(([id]) => id),
    ]),
  ];

  /**
   * Single writer per account.
   *
   * Not a performance choice — it is what makes "apply optimistically, then
   * reconcile" tractable at all. Two passes interleaving their reads and writes
   * would each be reconciling against a state the other was midway through
   * changing.
   *
   * Every pass is bounded (one page), so holding this never starves the other
   * lane: backfill takes a turn, the tail takes a turn.
   */
  let writer: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(body: () => Promise<T>): Promise<T> => {
    const result = writer.then(body, body);
    writer = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const readBlob = (id: string) => store.blobs.get(id as never);

  const commit = async (payloads: readonly EventPayload[], source: "remote" | "local") => {
    if (payloads.length === 0) return;
    const events = store.events.appendMany(
      payloads.map((payload) => ({ accountId, source, payload, at: now() })),
    );
    await store.projector.apply(events, readBlob);
  };

  // ------------------------------------------------------------------ ingest

  /**
   * Turn provider metadata into events.
   *
   * The blob is fetched only when we do not already hold it. Bodies are
   * immutable, so a message we have seen never needs its bytes again — which is
   * what makes a duplicated or reordered change batch cheap rather than
   * catastrophic.
   */
  const ingest = async (
    metas: readonly ProviderMessage[],
    options?: Cancellable,
  ): Promise<EventPayload[]> => {
    const payloads: EventPayload[] = [];

    for (const meta of metas) {
      const id = localMessageId(accountId, meta.providerId) as MessageId;
      const existing = store.getMessage(id);

      if (existing === null) {
        // No bytes server-side and none locally: there is no message here to
        // materialise. A tombstone reported by a metadata read is not new mail,
        // and asking for its body is how a refresh after a delete deadlocks.
        if (meta.providerBlobId === null) continue;
        const raw = await provider.fetchRaw(meta.providerId, options);
        const blob = await store.blobs.put(raw);
        payloads.push({ type: "blob.stored", blobId: blob.id, size: blob.size });
        payloads.push({
          type: "message.observed",
          messageId: id,
          blobId: blob.id,
          providerId: meta.providerId,
          receivedAt: meta.receivedAt as Instant,
        });
      }

      // A read that contradicts a change the provider told us it applied is
      // stale. Writing it is how the change disappears; the message stays
      // unsatisfied and we read it again.
      if (!believable(meta)) continue;

      payloads.push({ type: "message.keywords.set", messageId: id, keywords: [...meta.keywords] });
      payloads.push({
        type: "message.mailboxes.set",
        messageId: id,
        mailboxIds: meta.mailboxProviderIds.map(
          (providerId) => localMailboxId(accountId, providerId) as MailboxId,
        ),
      });
    }

    return payloads;
  };

  const fetchInChunks = async (
    providerIds: readonly string[],
    options?: Cancellable,
  ): Promise<ProviderMessage[]> => {
    const capabilities = await provider.capabilities();
    const chunkSize = Math.max(1, Math.min(pageSize, capabilities.maxObjectsPerFetch));
    const found: ProviderMessage[] = [];
    for (let i = 0; i < providerIds.length; i += chunkSize) {
      found.push(...(await provider.fetchMetadata(providerIds.slice(i, i + chunkSize), options)));
    }
    return found;
  };

  const syncMailboxes = async (options?: Cancellable): Promise<EventPayload[]> => {
    const mailboxes = await provider.listMailboxes(options);
    return mailboxes.map((mailbox) => ({
      type: "mailbox.upserted" as const,
      mailbox: {
        id: localMailboxId(accountId, mailbox.providerId) as MailboxId,
        accountId,
        providerId: mailbox.providerId,
        name: mailbox.name,
        parentId:
          mailbox.parentProviderId === null
            ? null
            : (localMailboxId(accountId, mailbox.parentProviderId) as MailboxId),
        role: mailbox.role,
        sortOrder: mailbox.sortOrder,
      },
    }));
  };

  // -------------------------------------------------------------------- tail

  const tailOnce = (options?: Cancellable): Promise<TailResult> =>
    exclusive(async () => {
      phase = "tailing";
      const startingCursor = store.cursors.get(accountId, COLLECTION);
      let resynchronised = false;

      let batch: Awaited<ReturnType<typeof provider.changes>>;
      try {
        batch = await provider.changes({
          collection: COLLECTION,
          cursor: startingCursor,
          limit: pageSize,
          ...(options ?? {}),
        });
      } catch (error) {
        const daak = toDaakError(error);
        // A cursor the server has forgotten is a conflict, not a failure. The
        // only correct response is to start again — giving up here strands the
        // account, and every mail client that has ever "stopped syncing after a
        // holiday" got this branch wrong.
        if (daak.kind === "conflict" && daak.code === ErrorCodes.CURSOR_INVALID) {
          resynchronised = true;
          store.cursors.setBackfill(accountId, COLLECTION, {
            lowWatermark: null,
            complete: false,
            updatedAt: now(),
          });
          batch = await provider.changes({
            collection: COLLECTION,
            cursor: null,
            limit: pageSize,
            ...(options ?? {}),
          });
        } else {
          phase = "error";
          lastErrorCode = daak.code;
          throw daak;
        }
      }

      const payloads: EventPayload[] = [];
      if (startingCursor === null || resynchronised) {
        payloads.push(...(await syncMailboxes(options)));
      }

      // De-duplicate before doing any work: a batch may name the same message
      // twice, and fetching it twice is pure waste.
      const changed = new Set<string>();
      const destroyed = new Set<string>();
      for (const change of batch.changes) {
        if (change.kind === "destroyed") destroyed.add(change.providerId);
        else changed.add(change.providerId);
      }

      for (const providerId of destroyed) {
        changed.delete(providerId);
        const id = localMessageId(accountId, providerId) as MessageId;
        if (store.getMessage(id) !== null) {
          payloads.push({ type: "message.removed", messageId: id });
        }
      }

      const metas = await fetchInChunks([...changed], options);
      payloads.push(...(await ingest(metas, options)));
      payloads.push({
        type: "sync.cursor.advanced",
        collection: COLLECTION,
        cursor: batch.cursor,
      });

      await commit(payloads, "remote");

      phase = "idle";
      lastSyncedAt = now();
      lastErrorCode = undefined;
      return {
        observed: metas.length,
        removed: destroyed.size,
        cursor: batch.cursor,
        hasMore: batch.hasMore,
        resynchronised,
      };
    });

  // ---------------------------------------------------------------- backfill

  const backfillOnce = (options?: Cancellable): Promise<BackfillResult> =>
    exclusive(async () => {
      const progress = store.cursors.getBackfill(accountId, COLLECTION);
      if (progress.complete) return { fetched: 0, complete: true };

      phase = "backfilling";
      const page = await provider.backfill({
        collection: COLLECTION,
        lowWatermark: progress.lowWatermark,
        limit: pageSize,
        ...(options ?? {}),
      });

      await commit(await ingest(page.items, options), "remote");
      store.cursors.setBackfill(accountId, COLLECTION, {
        lowWatermark: page.lowWatermark,
        complete: page.complete,
        updatedAt: now(),
      });

      phase = "idle";
      return { fetched: page.items.length, complete: page.complete };
    });

  // -------------------------------------------------------------- local edits

  /** The complete keyword set a message would have after `op`. */
  const applyLocally = (op: IntentOp): EventPayload[] => {
    const payloads: EventPayload[] = [];

    if (op.op === "keywords.change") {
      for (const messageId of op.messageIds) {
        const message = store.getMessage(messageId);
        if (message === null) continue;
        const next = new Set(message.keywords);
        for (const keyword of op.add) next.add(keyword);
        for (const keyword of op.remove) next.delete(keyword);
        // Absolute, not a delta: replaying this out of order still converges.
        payloads.push({
          type: "message.keywords.set",
          messageId,
          keywords: [...next].sort(),
        });
      }
      return payloads;
    }

    if (op.op === "mailboxes.change") {
      for (const messageId of op.messageIds) {
        const message = store.getMessage(messageId);
        if (message === null) continue;
        const next = new Set<string>(message.mailboxIds);
        for (const mailbox of op.add) next.add(mailbox);
        for (const mailbox of op.remove) next.delete(mailbox);
        payloads.push({
          type: "message.mailboxes.set",
          messageId,
          mailboxIds: [...next].sort() as MailboxId[],
        });
      }
      return payloads;
    }

    if (op.op === "message.destroy") {
      for (const messageId of op.messageIds) {
        if (store.getMessage(messageId) !== null) {
          payloads.push({ type: "message.removed", messageId });
        }
      }
      return payloads;
    }

    return payloads;
  };

  const record = (op: IntentOp): Promise<Intent> =>
    exclusive(async () => {
      const intent: Intent = {
        id: toIntentId(`i:${accountId}:${now()}:${intentCounter++}`),
        accountId,
        createdAt: now(),
        op,
        state: "pending",
        attempts: 0,
      };
      store.intents.record(intent);
      // Optimistic: the user sees the result immediately, whether or not the
      // network is there. Reconciliation is what makes that honest.
      await commit(applyLocally(op), "local");
      return intent;
    });

  // -------------------------------------------------------------------- push

  /** Translate a local intent into the provider's own vocabulary. */
  const translate = (intent: Intent): ProviderIntent => {
    const op = intent.op;
    const toProviderIds = (ids: readonly MessageId[]): string[] =>
      ids
        .map((id) => store.getMessage(id)?.providerId ?? providerIdOf(id))
        .filter((id) => id !== "");

    let mutation: ProviderMutation;
    switch (op.op) {
      case "keywords.change":
        mutation = {
          kind: "keywords.change",
          providerIds: toProviderIds(op.messageIds),
          add: op.add,
          remove: op.remove,
        };
        break;
      case "mailboxes.change":
        mutation = {
          kind: "mailboxes.change",
          providerIds: toProviderIds(op.messageIds),
          add: op.add.map(providerIdOf),
          remove: op.remove.map(providerIdOf),
        };
        break;
      case "message.destroy":
        mutation = { kind: "message.destroy", providerIds: toProviderIds(op.messageIds) };
        break;
      case "mailbox.create":
        mutation = {
          kind: "mailbox.create",
          name: op.name,
          parentProviderId: op.parentId === null ? null : providerIdOf(op.parentId),
        };
        break;
      case "mailbox.rename":
        mutation = {
          kind: "mailbox.rename",
          providerId: providerIdOf(op.mailboxId),
          name: op.name,
        };
        break;
      case "mailbox.destroy":
        mutation = { kind: "mailbox.destroy", providerId: providerIdOf(op.mailboxId) };
        break;
      default:
        // draft.save and message.send go through uploadBlob + submit, which is
        // the compose lane in week 4. Refusing loudly beats a silent no-op that
        // leaves an intent pending for ever.
        throw DaakError.permanent(
          ErrorCodes.UNSUPPORTED,
          `sync cannot push ${op.op} yet — compose lands in week 4`,
        );
    }
    return { intentId: intent.id, mutation };
  };

  /** Message provider ids an intent touched, for refreshing after a rejection. */
  const touchedProviderIds = (intent: Intent): string[] => {
    const op = intent.op;
    if (
      op.op === "keywords.change" ||
      op.op === "mailboxes.change" ||
      op.op === "message.destroy"
    ) {
      return op.messageIds.map((id) => store.getMessage(id)?.providerId ?? providerIdOf(id));
    }
    return [];
  };

  /**
   * Replace local state for these messages with what the server actually holds.
   *
   * This is the "replay and reconcile" half of optimistic application. A
   * rejected mutation must not stay on screen as though it worked, and the only
   * authority on what is true is the server.
   */
  const refresh = async (providerIds: readonly string[], options?: Cancellable): Promise<void> => {
    const unique = [...new Set(providerIds)].filter((id) => id !== "");
    if (unique.length === 0) return;
    const metas = await fetchInChunks(unique, options);
    // A message the provider still lists but has no bytes for is a tombstone.
    const live = metas.filter((meta) => meta.providerBlobId !== null);
    const seen = new Set(live.map((meta) => meta.providerId));
    const payloads = await ingest(live, options);

    // Anything the server no longer knows about is gone, whatever we thought.
    for (const providerId of unique) {
      if (seen.has(providerId)) continue;
      guards.delete(providerId);
      needsRead.delete(providerId);
      const id = localMessageId(accountId, providerId) as MessageId;
      if (store.getMessage(id) !== null) {
        payloads.push({ type: "message.removed", messageId: id });
      }
    }
    await commit(payloads, "remote");
  };

  const pushOnce = (options?: Cancellable): Promise<PushResult> =>
    exclusive(async () => {
      const outstanding = store.intents.outstanding(accountId);
      if (outstanding.length === 0) {
        return { settled: 0, rejected: 0, unknown: 0, deferred: 0 };
      }

      phase = "pushing";
      const pushable: Intent[] = [];
      let rejected = 0;
      const toRefresh: string[] = [];

      for (const intent of outstanding) {
        try {
          translate(intent);
          pushable.push(intent);
        } catch (error) {
          const daak = toDaakError(error);
          store.intents.update(intent.id, {
            state: "rejected",
            lastError: daak.toJSON(),
            lastAttemptAt: now(),
          });
          toRefresh.push(...touchedProviderIds(intent));
          rejected += 1;
        }
      }

      let outcomes: readonly IntentOutcome[] = [];
      let unknown = 0;
      const deferred = 0;

      if (pushable.length > 0) {
        for (const intent of pushable) {
          store.intents.update(intent.id, {
            state: "inflight",
            attempts: intent.attempts + 1,
            lastAttemptAt: now(),
          });
        }

        try {
          outcomes = await provider.apply(pushable.map(translate), options);
        } catch (error) {
          const daak = toDaakError(error);
          lastErrorCode = daak.code;

          if (daak.kind === "auth") {
            // Nothing was applied: the request never authenticated. Safe to
            // leave pending and stop bothering the server until the user acts.
            for (const intent of pushable) store.intents.update(intent.id, { state: "pending" });
            phase = "error";
            return { settled: 0, rejected, unknown: 0, deferred: pushable.length };
          }

          // Everything else is genuinely ambiguous. The request may have left
          // the machine and been applied; it may not have. `unknown` is the
          // honest answer, and the next push resolves it by re-sending under
          // the same idempotency key — which the provider contract requires to
          // be a no-op if it already landed.
          for (const intent of pushable) {
            store.intents.update(intent.id, { state: "unknown", lastError: daak.toJSON() });
            expect(touchedProviderIds(intent), null);
          }
          phase = "error";
          if (toRefresh.length > 0) await refresh(toRefresh, options);
          return { settled: 0, rejected, unknown: pushable.length, deferred: 0 };
        }
      }

      const byId = new Map(outcomes.map((outcome) => [String(outcome.intentId), outcome]));
      let settled = 0;

      for (const intent of pushable) {
        const outcome = byId.get(String(intent.id));
        if (outcome === undefined) {
          // The provider returned no verdict for this one. Not applied, not
          // rejected — unknown, same as a lost response.
          store.intents.update(intent.id, { state: "unknown" });
          expect(touchedProviderIds(intent), null);
          unknown += 1;
          continue;
        }
        if (outcome.status === "applied") {
          store.intents.update(intent.id, { state: "settled", lastError: null });
          // Applied is the provider's word, not an observation. Verify it, and
          // know what we are looking for.
          expect(touchedProviderIds(intent), expectationOf(intent));
          settled += 1;
        } else if (outcome.status === "rejected") {
          store.intents.update(intent.id, {
            state: "rejected",
            ...(outcome.error === undefined ? {} : { lastError: outcome.error }),
          });
          toRefresh.push(...touchedProviderIds(intent));
          rejected += 1;
        } else {
          store.intents.update(intent.id, { state: "unknown" });
          expect(touchedProviderIds(intent), null);
          unknown += 1;
        }
      }

      expect(toRefresh, null);
      const outstandingReads = unsettled();
      if (outstandingReads.length > 0) await refresh(outstandingReads, options);

      phase = "idle";
      return { settled, rejected, unknown, deferred };
    });

  // ------------------------------------------------------------------ settle

  const fingerprint = (): string =>
    JSON.stringify([
      store.cursors.get(accountId, COLLECTION),
      store.cursors.getBackfill(accountId, COLLECTION),
      store.intents.countByState(accountId),
      store.snapshot(accountId).messages,
    ]);

  const settle = async (
    options: { maxRounds?: number } & Cancellable = {},
  ): Promise<SettleResult> => {
    const maxRounds = options.maxRounds ?? 20;

    for (let round = 1; round <= maxRounds; round += 1) {
      const before = fingerprint();

      // Errors are expected here — that is the point of the lane. Record and
      // keep going; the next round retries. A settle that gives up on the first
      // disconnect would never converge after a fault storm.
      let pushed: PushResult = { settled: 0, rejected: 0, unknown: 0, deferred: 0 };
      try {
        pushed = await pushOnce(options);
      } catch (error) {
        lastErrorCode = toDaakError(error).code;
      }

      let tail: TailResult | undefined;
      try {
        tail = await tailOnce(options);
      } catch (error) {
        lastErrorCode = toDaakError(error).code;
      }

      const outstandingReads = unsettled();
      if (outstandingReads.length > 0) {
        try {
          await exclusive(() => refresh(outstandingReads, options));
        } catch (error) {
          lastErrorCode = toDaakError(error).code;
        }
      }

      const backfill = store.cursors.getBackfill(accountId, COLLECTION);
      if (!backfill.complete) {
        try {
          await backfillOnce(options);
        } catch (error) {
          lastErrorCode = toDaakError(error).code;
        }
      }

      const outstanding = store.intents.countOutstanding(accountId);
      const quiet =
        fingerprint() === before &&
        outstanding === 0 &&
        unsettled().length === 0 &&
        pushed.unknown === 0 &&
        pushed.deferred === 0 &&
        tail !== undefined &&
        !tail.hasMore &&
        store.cursors.getBackfill(accountId, COLLECTION).complete;

      if (quiet) return { rounds: round, quiescent: true };
    }

    return { rounds: maxRounds, quiescent: false };
  };

  return {
    accountId,
    record,
    tailOnce,
    backfillOnce,
    pushOnce,
    settle,
    status: (): SyncStatus => ({
      accountId,
      phase,
      pendingIntents: store.intents.countOutstanding(accountId),
      ...(lastErrorCode === undefined ? {} : { lastErrorCode }),
      ...(lastSyncedAt === undefined ? {} : { lastSyncedAt }),
    }),
  };
};

export { isDaakError };
