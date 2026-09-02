import {
  type AccountId,
  type Cancellable,
  type ChangeBatch,
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
  type Unsubscribe,
} from "@daak/contracts";
import {
  createJmapClient,
  type JmapClient,
  type JmapClientOptions,
  type MethodCall,
  responseFor,
} from "./client.js";
import { mapJmapError } from "./errors.js";
import { buildPatch, EMAIL_PROPERTIES, toProviderMailbox, toProviderMessage } from "./mapping.js";

export interface JmapProviderOptions extends JmapClientOptions {
  readonly accountId: AccountId;
  readonly client?: JmapClient;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const asStrings = (value: unknown): string[] => asArray(value).map(String);

const chunk = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += Math.max(1, size)) out.push(items.slice(i, i + size));
  return out;
};

/**
 * A JMAP `MailProvider` (RFC 8620 core, RFC 8621 mail).
 *
 * The rules this implementation is written against are in CLAUDE.md; the two
 * that shape the code most are that no JMAP vocabulary crosses the boundary,
 * and that every `SetError` is mapped explicitly rather than defaulted.
 */
export const createJmapProvider = (options: JmapProviderOptions): MailProvider => {
  const client = options.client ?? createJmapClient(options);
  /** JMAP has no idempotency primitive for submission. See `submit`. */
  const submissions = new Map<string, SubmitOutcome>();
  /** Resolved once: submission needs it every time and it rarely moves. */
  let draftsMailboxId: string | undefined;

  const jmapAccount = async (options_?: Cancellable): Promise<string> =>
    (await client.session(options_)).accountId;

  const capabilities = async (options_?: Cancellable): Promise<ProviderCapabilities> => {
    const session = await client.session(options_);
    return {
      maxObjectsPerFetch: session.maxObjectsInGet,
      supportsPush: session.supportsPush,
      supportsIncrementalChanges: true,
      supportsBlobUpload: session.uploadUrl !== "",
      maxUploadBytes: session.maxSizeUpload,
      quirks: [],
    };
  };

  /** The current `Email` state string, for a tail that is starting from now. */
  const currentEmailState = async (options_?: Cancellable): Promise<string> => {
    const accountId = await jmapAccount(options_);
    const responses = await client.call([["Email/get", { accountId, ids: [] }, "state"]], options_);
    return String(responseFor(responses, "state").state ?? "");
  };

  const fetchMetadata = async (
    providerIds: readonly string[],
    options_?: Cancellable,
  ): Promise<readonly ProviderMessage[]> => {
    if (providerIds.length === 0) return [];
    const session = await client.session(options_);
    if (providerIds.length > session.maxObjectsInGet) {
      throw DaakError.permanent(
        ErrorCodes.INVALID_INPUT,
        `asked for ${providerIds.length} objects, the server's limit is ${session.maxObjectsInGet}`,
        { context: { limit: session.maxObjectsInGet } },
      );
    }
    const responses = await client.call(
      [
        [
          "Email/get",
          { accountId: session.accountId, ids: providerIds, properties: [...EMAIL_PROPERTIES] },
          "get",
        ],
      ],
      options_,
    );
    // `notFound` is not an error: a message can be destroyed between the change
    // report and the fetch. The sync engine treats an absent id as removed.
    return asArray(responseFor(responses, "get").list).map(toProviderMessage);
  };

  return {
    kind: "jmap",
    accountId: options.accountId,
    capabilities,

    async listMailboxes(options_?: Cancellable): Promise<readonly ProviderMailbox[]> {
      const accountId = await jmapAccount(options_);
      const responses = await client.call(
        [["Mailbox/get", { accountId, ids: null }, "mailboxes"]],
        options_,
      );
      return asArray(responseFor(responses, "mailboxes").list).map(toProviderMailbox);
    },

    async changes(input): Promise<ChangeBatch> {
      const collection: SyncCollection = input.collection;
      const accountId = await jmapAccount(input);

      // A null cursor means "start from now" — the contract is explicit that
      // history is backfill's job, not the tail's. So take the server's current
      // state and report nothing changed, rather than replaying the mailbox
      // through a lane that is not meant to carry it.
      if (input.cursor === null) {
        return {
          collection,
          changes: [],
          cursor: await currentEmailState(input),
          hasMore: false,
        };
      }

      const responses = await client.call(
        [
          [
            "Email/changes",
            { accountId, sinceState: input.cursor, maxChanges: input.limit },
            "changes",
          ],
        ],
        input,
      );
      const result = responseFor(responses, "changes");

      const changes: ProviderChange[] = [
        ...asStrings(result.created).map(
          (providerId): ProviderChange => ({ kind: "created", providerId }),
        ),
        ...asStrings(result.updated).map(
          (providerId): ProviderChange => ({ kind: "updated", providerId }),
        ),
        ...asStrings(result.destroyed).map(
          (providerId): ProviderChange => ({ kind: "destroyed", providerId }),
        ),
      ];

      return {
        collection,
        changes,
        cursor: String(result.newState ?? input.cursor),
        hasMore: result.hasMoreChanges === true,
      };
    },

    async backfill(input) {
      const accountId = await jmapAccount(input);

      // Walk downwards by received time rather than by position. Position-based
      // paging silently skips a message every time new mail arrives at the top,
      // and during a first sync that is exactly when it arrives.
      const filter = input.lowWatermark === null ? undefined : { before: input.lowWatermark };
      const query: MethodCall = [
        "Email/query",
        {
          accountId,
          ...(filter === undefined ? {} : { filter }),
          sort: [{ property: "receivedAt", isAscending: false }],
          limit: input.limit,
          calculateTotal: false,
        },
        "query",
      ];
      const get: MethodCall = [
        "Email/get",
        {
          accountId,
          // Back-reference: fetch exactly what the query returned, in one round
          // trip, with no chance of the two disagreeing.
          "#ids": { resultOf: "query", name: "Email/query", path: "/ids" },
          properties: [...EMAIL_PROPERTIES],
        },
        "get",
      ];

      const responses = await client.call([query, get], input);
      const items = asArray(responseFor(responses, "get").list).map(toProviderMessage);
      const last = items[items.length - 1];

      return {
        items,
        lowWatermark: last?.receivedAt ?? input.lowWatermark,
        // Fewer than asked for means the tail of history. `before` is exclusive,
        // so an exact-limit page always gets one more round trip to confirm.
        complete: items.length < input.limit,
      };
    },

    fetchMetadata,

    async fetchRaw(providerId, options_) {
      const [message] = await fetchMetadata([providerId], options_);
      if (message === undefined || message.providerBlobId === null) {
        throw DaakError.permanent(ErrorCodes.NOT_FOUND, "no blob for that message", {
          context: { providerId },
        });
      }
      return client.download(message.providerBlobId, options_);
    },

    async uploadBlob(bytes, options_) {
      return { providerBlobId: await client.upload(bytes, "message/rfc822", options_) };
    },

    async apply(intents, options_): Promise<readonly IntentOutcome[]> {
      if (intents.length === 0) return [];
      const session = await client.session(options_);
      const accountId = session.accountId;
      const outcomes: IntentOutcome[] = [];

      // One `set` call per intent, batched into as few requests as the server
      // allows. Merging intents into a single call would make a partial failure
      // impossible to attribute, and attribution is the whole point: the engine
      // has to know which of the user's changes landed.
      for (const group of chunk([...intents], session.maxCallsInRequest)) {
        const calls: MethodCall[] = group.map((intent, index) => {
          const callId = String(index);
          const mutation = intent.mutation;
          switch (mutation.kind) {
            case "keywords.change":
              return [
                "Email/set",
                {
                  accountId,
                  update: Object.fromEntries(
                    mutation.providerIds.map((id) => [
                      id,
                      buildPatch("keywords", mutation.add, mutation.remove),
                    ]),
                  ),
                },
                callId,
              ];
            case "mailboxes.change":
              return [
                "Email/set",
                {
                  accountId,
                  update: Object.fromEntries(
                    mutation.providerIds.map((id) => [
                      id,
                      buildPatch("mailboxIds", mutation.add, mutation.remove),
                    ]),
                  ),
                },
                callId,
              ];
            case "message.destroy":
              return ["Email/set", { accountId, destroy: [...mutation.providerIds] }, callId];
            case "mailbox.create":
              return [
                "Mailbox/set",
                {
                  accountId,
                  create: {
                    new: { name: mutation.name, parentId: mutation.parentProviderId },
                  },
                },
                callId,
              ];
            case "mailbox.rename":
              return [
                "Mailbox/set",
                { accountId, update: { [mutation.providerId]: { name: mutation.name } } },
                callId,
              ];
            case "mailbox.destroy":
              return ["Mailbox/set", { accountId, destroy: [mutation.providerId] }, callId];
            default:
              return ["Email/get", { accountId, ids: [] }, callId];
          }
        });

        let responses: Awaited<ReturnType<typeof client.call>>;
        try {
          responses = await client.call(calls, options_);
        } catch (error) {
          // The batch never produced verdicts. Every intent in it is ambiguous —
          // the request may have been applied before the failure — so none may
          // be reported as rejected.
          for (const intent of group) {
            outcomes.push({
              intentId: intent.intentId,
              status: "unknown",
              ...(error instanceof DaakError ? { error: error.toJSON() } : {}),
            });
          }
          continue;
        }

        group.forEach((intent, index) => {
          const result = responseFor(responses, String(index));
          outcomes.push(readSetOutcome(intent, result));
        });
      }

      return outcomes;
    },

    async submit(request: SubmitRequest): Promise<SubmitOutcome> {
      const previous = submissions.get(request.idempotencyKey);
      if (previous !== undefined) return previous;

      const accountId = await jmapAccount(request);
      if (draftsMailboxId === undefined) {
        const mailboxes = await this.listMailboxes(request);
        draftsMailboxId = mailboxes.find((mailbox) => mailbox.role === "drafts")?.providerId;
      }
      if (draftsMailboxId === undefined) {
        throw DaakError.permanent(ErrorCodes.UNSUPPORTED, "the account has no drafts mailbox");
      }

      const importCall: MethodCall = [
        "Email/import",
        {
          accountId,
          emails: {
            outgoing: {
              blobId: request.providerBlobId,
              mailboxIds: { [draftsMailboxId]: true },
              keywords: { $draft: true },
            },
          },
        },
        "import",
      ];
      const submitCall: MethodCall = [
        "EmailSubmission/set",
        {
          accountId,
          create: {
            submission: {
              // A creation reference to the import above: one request, and no
              // window in which a draft exists that nothing will ever send.
              emailId: "#outgoing",
              envelope: {
                mailFrom: { email: request.mailFrom.address },
                rcptTo: request.rcptTo.map((recipient) => ({ email: recipient.address })),
              },
            },
          },
        },
        "submit",
      ];

      let responses: Awaited<ReturnType<typeof client.call>>;
      try {
        responses = await client.call([importCall, submitCall], request);
      } catch (error) {
        // Never report a send as failed when it may have gone out. Sending
        // someone's mail twice is worse than any error message.
        const outcome: SubmitOutcome = { status: "unknown" };
        if (error instanceof DaakError && error.kind !== "transient") throw error;
        return outcome;
      }

      const result = responseFor(responses, "submit");
      const created = asRecord(asRecord(result.created).submission);
      const notCreated = asRecord(asRecord(result.notCreated).submission);

      if (typeof created.id === "string") {
        const outcome: SubmitOutcome = { status: "accepted", providerId: created.id };
        submissions.set(request.idempotencyKey, outcome);
        return outcome;
      }
      if (notCreated.type !== undefined) {
        throw mapJmapError({
          type: String(notCreated.type),
          description: String(notCreated.description ?? ""),
        });
      }
      return { status: "unknown" };
    },

    watch(): Unsubscribe {
      // EventSource push is a later refinement. Returning a no-op is honest:
      // `supportsPush` already tells the engine to poll, and a watch that
      // silently never fires would be worse than none.
      return () => undefined;
    },

    async close() {
      submissions.clear();
      draftsMailboxId = undefined;
    },
  };
};

/**
 * Read one `Foo/set` response into an outcome.
 *
 * The subtlety worth reading twice is `notFound` on a destroy. JMAP has no
 * idempotency key, so a retry after an ambiguous failure re-sends the destroy —
 * and the second attempt reports `notFound` because the first one worked.
 * Calling that a rejection makes the engine resurrect a message the user
 * deleted, so it counts as applied.
 */
const readSetOutcome = (intent: ProviderIntent, result: Record<string, unknown>): IntentOutcome => {
  const isDestroy =
    intent.mutation.kind === "message.destroy" || intent.mutation.kind === "mailbox.destroy";

  const notUpdated = asRecord(result.notUpdated);
  const notDestroyed = asRecord(result.notDestroyed);
  const notCreated = asRecord(result.notCreated);
  const failures = { ...notUpdated, ...notDestroyed, ...notCreated };
  const firstFailure = Object.values(failures)[0];

  if (firstFailure === undefined) {
    const created = asRecord(result.created);
    const createdId = Object.values(created).map((value) => asRecord(value).id)[0];
    return {
      intentId: intent.intentId,
      status: "applied",
      cursor: String(result.newState ?? ""),
      ...(typeof createdId === "string" ? { createdProviderId: createdId } : {}),
    };
  }

  const problem = asRecord(firstFailure);
  const type = String(problem.type ?? "unknown");

  if (isDestroy && type === "notFound") {
    // Already gone, which is what we asked for.
    return { intentId: intent.intentId, status: "applied", cursor: String(result.newState ?? "") };
  }

  const error = mapJmapError({ type, description: String(problem.description ?? "") });
  // `rejected` tells the engine to roll the user's change back, so it is only
  // for a refusal that will still be a refusal next time. Transient means the
  // server was briefly unable; conflict means our view of state was wrong. In
  // both cases the honest answer is that this is unresolved — re-read, then
  // retry under the same id — not that the user's change was refused.
  const unresolved = error.kind === "transient" || error.kind === "conflict";
  return {
    intentId: intent.intentId,
    status: unresolved ? "unknown" : "rejected",
    error: error.toJSON(),
  };
};
