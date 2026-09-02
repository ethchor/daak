/**
 * A JMAP server, in memory, over an injected `fetch`.
 *
 * Enough of RFC 8620/8621 to exercise the adapter honestly: session discovery,
 * `Email/changes` with real state strings, `Email/query` with a `before`
 * filter, `Email/set` patch semantics, blob download and upload, and
 * `EmailSubmission/set` behind a creation reference.
 *
 * It is not a conformance implementation and does not pretend to be. Its job is
 * to make the interesting failures reachable — an expired state string, a
 * partial `SetError`, a transport that dies mid-write — which no real server
 * will produce on demand.
 */
export interface FakeEmail {
  id: string;
  blobId: string;
  size: number;
  receivedAt: string;
  keywords: Record<string, true>;
  mailboxIds: Record<string, true>;
  raw: Uint8Array;
  destroyed?: boolean;
}

export interface FakeMailbox {
  id: string;
  name: string;
  role: string | null;
  parentId: string | null;
  sortOrder: number;
}

export interface FakeJmap {
  readonly fetch: typeof globalThis.fetch;
  readonly emails: Map<string, FakeEmail>;
  readonly mailboxes: Map<string, FakeMailbox>;
  readonly blobs: Map<string, Uint8Array>;
  readonly requests: string[];
  state: number;
  /** Forget change history, so the next `Email/changes` cannot be answered. */
  forgetHistory(): void;
  /** Fail the next N api requests at the HTTP level. */
  failNext(count: number, status: number): void;
  /** Make the next api request die at the transport layer. */
  dropNext(): void;
  /** Refuse the next `set` on this id with this SetError type. */
  refuseNext(id: string, type: string): void;
  addEmail(input: Partial<FakeEmail> & { id: string }): FakeEmail;
}

const encoder = new TextEncoder();

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export const createFakeJmap = (options: { maxObjectsInGet?: number } = {}): FakeJmap => {
  const emails = new Map<string, FakeEmail>();
  const mailboxes = new Map<string, FakeMailbox>();
  const blobs = new Map<string, Uint8Array>();
  const requests: string[] = [];
  /** id → state at which it last changed. A real server's change log. */
  const changedAt = new Map<string, number>();
  let historyFloor = 0;
  let failures = 0;
  let failureStatus = 500;
  let dropNextRequest = false;
  const refusals = new Map<string, string>();
  let uploaded = 0;

  const server: FakeJmap = {
    emails,
    mailboxes,
    blobs,
    requests,
    state: 0,
    forgetHistory() {
      historyFloor = server.state;
    },
    failNext(count, status) {
      failures = count;
      failureStatus = status;
    },
    dropNext() {
      dropNextRequest = true;
    },
    refuseNext(id, type) {
      refusals.set(id, type);
    },
    addEmail(input) {
      server.state += 1;
      const raw =
        input.raw ??
        encoder.encode(
          `Message-ID: <${input.id}@example.org>\r\nSubject: ${input.id}\r\n\r\nbody\r\n`,
        );
      const blobId = input.blobId ?? `B-${input.id}`;
      blobs.set(blobId, raw);
      const email: FakeEmail = {
        id: input.id,
        blobId,
        size: raw.byteLength,
        receivedAt:
          input.receivedAt ?? new Date(Date.UTC(2026, 0, 1, 0, server.state, 0)).toISOString(),
        keywords: input.keywords ?? {},
        mailboxIds: input.mailboxIds ?? { mb1: true },
        raw,
      };
      emails.set(email.id, email);
      changedAt.set(email.id, server.state);
      return email;
    },
    fetch: (async (input: unknown, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      requests.push(`${init?.method ?? "GET"} ${url}`);

      if (url.includes("/.well-known/jmap")) {
        return json({
          capabilities: {
            "urn:ietf:params:jmap:core": {
              maxObjectsInGet: options.maxObjectsInGet ?? 3,
              maxObjectsInSet: 10,
              maxCallsInRequest: 4,
              maxSizeUpload: 1024 * 1024,
            },
            "urn:ietf:params:jmap:mail": {},
            "urn:ietf:params:jmap:submission": {},
          },
          accounts: { acc1: { name: "you@example.org" } },
          primaryAccounts: { "urn:ietf:params:jmap:mail": "acc1" },
          apiUrl: "https://mail.example.org/jmap/api",
          downloadUrl: "https://mail.example.org/jmap/download/{accountId}/{blobId}/{name}",
          uploadUrl: "https://mail.example.org/jmap/upload/{accountId}",
          eventSourceUrl: "https://mail.example.org/jmap/events",
          state: "session-1",
        });
      }

      if (url.includes("/jmap/download/")) {
        const blobId = decodeURIComponent(url.split("/download/")[1]?.split("/")[1] ?? "");
        const bytes = blobs.get(blobId);
        if (bytes === undefined) return new Response("not found", { status: 404 });
        return new Response(bytes as unknown as ArrayBuffer, { status: 200 });
      }

      if (url.includes("/jmap/upload/")) {
        const body = init?.body;
        const bytes =
          body instanceof Uint8Array ? body : encoder.encode(typeof body === "string" ? body : "");
        uploaded += 1;
        const blobId = `U${uploaded}`;
        blobs.set(blobId, bytes);
        return json({ accountId: "acc1", blobId, type: "message/rfc822", size: bytes.byteLength });
      }

      // ------------------------------------------------------------ api
      if (dropNextRequest) {
        dropNextRequest = false;
        throw new TypeError("fetch failed");
      }
      if (failures > 0) {
        failures -= 1;
        return new Response("server said no", { status: failureStatus });
      }

      const request = JSON.parse(String(init?.body ?? "{}")) as {
        methodCalls: [string, Record<string, unknown>, string][];
      };
      const responses: [string, Record<string, unknown>, string][] = [];
      /** Creation ids resolved for `#ref` back-references within this request. */
      const created = new Map<string, string>();
      const results = new Map<string, Record<string, unknown>>();

      for (const [name, rawArgs, callId] of request.methodCalls) {
        const args = { ...rawArgs };

        // Back-reference: `#ids` resolved from an earlier call's result path.
        const reference = args["#ids"] as
          | { resultOf: string; name: string; path: string }
          | undefined;
        if (reference !== undefined) {
          const source = results.get(reference.resultOf) ?? {};
          args.ids = (source[reference.path.replace("/", "")] as unknown[]) ?? [];
          delete args["#ids"];
        }

        if (name === "Mailbox/get") {
          const result = {
            accountId: "acc1",
            state: String(server.state),
            list: [...mailboxes.values()],
          };
          results.set(callId, result);
          responses.push([name, result, callId]);
          continue;
        }

        if (name === "Email/get") {
          const ids = (args.ids as string[] | null) ?? [];
          const list = ids
            .map((id) => emails.get(id))
            .filter((email): email is FakeEmail => email !== undefined && email.destroyed !== true)
            .map((email) => ({
              id: email.id,
              blobId: email.blobId,
              size: email.size,
              receivedAt: email.receivedAt,
              keywords: email.keywords,
              mailboxIds: email.mailboxIds,
            }));
          const result = {
            accountId: "acc1",
            state: String(server.state),
            list,
            notFound: ids.filter((id) => !list.some((email) => email.id === id)),
          };
          results.set(callId, result);
          responses.push([name, result, callId]);
          continue;
        }

        if (name === "Email/changes") {
          const since = Number.parseInt(String(args.sinceState ?? "0"), 10);
          if (!Number.isFinite(since) || since < historyFloor) {
            // The state string is older than anything we still remember.
            responses.push(["error", { type: "cannotCalculateChanges" }, callId]);
            continue;
          }
          const limit = Number(args.maxChanges ?? 50);
          const changed = [...changedAt.entries()]
            .filter(([, at]) => at > since)
            .sort((a, b) => a[1] - b[1]);
          const page = changed.slice(0, limit);
          const result = {
            accountId: "acc1",
            oldState: String(since),
            newState: String(page[page.length - 1]?.[1] ?? server.state),
            hasMoreChanges: changed.length > limit,
            created: page.filter(([id]) => emails.get(id)?.destroyed !== true).map(([id]) => id),
            updated: [],
            destroyed: page.filter(([id]) => emails.get(id)?.destroyed === true).map(([id]) => id),
          };
          results.set(callId, result);
          responses.push([name, result, callId]);
          continue;
        }

        if (name === "Email/query") {
          const filter = args.filter as { before?: string } | undefined;
          const ordered = [...emails.values()]
            .filter((email) => email.destroyed !== true)
            .filter((email) => filter?.before === undefined || email.receivedAt < filter.before)
            .sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1))
            .slice(0, Number(args.limit ?? 50));
          const result = {
            accountId: "acc1",
            queryState: String(server.state),
            ids: ordered.map((email) => email.id),
            position: 0,
          };
          results.set(callId, result);
          responses.push([name, result, callId]);
          continue;
        }

        if (name === "Email/set" || name === "Mailbox/set") {
          const update = (args.update ?? {}) as Record<string, Record<string, unknown>>;
          const destroy = (args.destroy ?? []) as string[];
          const create = (args.create ?? {}) as Record<string, Record<string, unknown>>;

          const updated: Record<string, null> = {};
          const notUpdated: Record<string, unknown> = {};
          const destroyed: string[] = [];
          const notDestroyed: Record<string, unknown> = {};
          const createdOut: Record<string, unknown> = {};

          for (const [id, patch] of Object.entries(update)) {
            const refusal = refusals.get(id);
            if (refusal !== undefined) {
              refusals.delete(id);
              notUpdated[id] = { type: refusal, description: `refused ${id}` };
              continue;
            }
            const email = emails.get(id);
            if (email === undefined || email.destroyed === true) {
              notUpdated[id] = { type: "notFound" };
              continue;
            }
            for (const [pointer, value] of Object.entries(patch)) {
              const [property, ...rest] = pointer.split("/");
              const key = rest.join("/").replace(/~1/g, "/").replace(/~0/g, "~");
              const target =
                property === "keywords"
                  ? email.keywords
                  : property === "mailboxIds"
                    ? email.mailboxIds
                    : undefined;
              if (target === undefined) continue;
              if (value === null) delete target[key];
              else target[key] = true;
            }
            server.state += 1;
            changedAt.set(id, server.state);
            updated[id] = null;
          }

          for (const id of destroy) {
            const refusal = refusals.get(id);
            if (refusal !== undefined) {
              refusals.delete(id);
              notDestroyed[id] = { type: refusal };
              continue;
            }
            const email = emails.get(id);
            const mailbox = mailboxes.get(id);
            if (email !== undefined && email.destroyed !== true) {
              email.destroyed = true;
              server.state += 1;
              changedAt.set(id, server.state);
              destroyed.push(id);
            } else if (mailbox !== undefined) {
              mailboxes.delete(id);
              server.state += 1;
              destroyed.push(id);
            } else {
              // Already gone. A retried destroy lands here.
              notDestroyed[id] = { type: "notFound" };
            }
          }

          for (const [creationId, values] of Object.entries(create)) {
            server.state += 1;
            const id = `new-${server.state}`;
            if (name === "Mailbox/set") {
              mailboxes.set(id, {
                id,
                name: String(values.name ?? ""),
                role: null,
                parentId: (values.parentId as string | null) ?? null,
                sortOrder: mailboxes.size,
              });
            }
            created.set(creationId, id);
            createdOut[creationId] = { id };
          }

          const result = {
            accountId: "acc1",
            oldState: String(server.state),
            newState: String(server.state),
            updated,
            notUpdated,
            destroyed,
            notDestroyed,
            created: createdOut,
            notCreated: {},
          };
          results.set(callId, result);
          responses.push([name, result, callId]);
          continue;
        }

        if (name === "Email/import") {
          const toImport = (args.emails ?? {}) as Record<string, Record<string, unknown>>;
          const createdOut: Record<string, unknown> = {};
          for (const [creationId, values] of Object.entries(toImport)) {
            const blobId = String(values.blobId ?? "");
            const raw = blobs.get(blobId);
            if (raw === undefined) {
              responses.push([
                name,
                { notCreated: { [creationId]: { type: "notFound" } } },
                callId,
              ]);
              continue;
            }
            server.state += 1;
            const id = `imported-${server.state}`;
            emails.set(id, {
              id,
              blobId,
              size: raw.byteLength,
              receivedAt: new Date(Date.UTC(2026, 0, 2, 0, server.state, 0)).toISOString(),
              keywords: (values.keywords ?? {}) as Record<string, true>,
              mailboxIds: (values.mailboxIds ?? {}) as Record<string, true>,
              raw,
            });
            changedAt.set(id, server.state);
            created.set(creationId, id);
            createdOut[creationId] = { id, blobId };
          }
          const result = { accountId: "acc1", created: createdOut, notCreated: {} };
          results.set(callId, result);
          responses.push([name, result, callId]);
          continue;
        }

        if (name === "EmailSubmission/set") {
          const toCreate = (args.create ?? {}) as Record<string, Record<string, unknown>>;
          const createdOut: Record<string, unknown> = {};
          const notCreated: Record<string, unknown> = {};
          for (const [creationId, values] of Object.entries(toCreate)) {
            const emailRef = String(values.emailId ?? "");
            const emailId = emailRef.startsWith("#") ? created.get(emailRef.slice(1)) : emailRef;
            if (emailId === undefined || !emails.has(emailId)) {
              notCreated[creationId] = { type: "notFound", description: "no such email" };
              continue;
            }
            server.state += 1;
            createdOut[creationId] = { id: `sub-${server.state}`, emailId };
          }
          const result = { accountId: "acc1", created: createdOut, notCreated };
          results.set(callId, result);
          responses.push([name, result, callId]);
          continue;
        }

        responses.push(["error", { type: "unknownMethod" }, callId]);
      }

      return json({ methodResponses: responses, sessionState: "session-1" });
    }) as unknown as typeof globalThis.fetch,
  };

  mailboxes.set("mb1", { id: "mb1", name: "Inbox", role: "inbox", parentId: null, sortOrder: 0 });
  mailboxes.set("mb2", {
    id: "mb2",
    name: "Archive",
    role: "archive",
    parentId: null,
    sortOrder: 1,
  });
  mailboxes.set("mb3", { id: "mb3", name: "Drafts", role: "drafts", parentId: null, sortOrder: 2 });
  mailboxes.set("mb4", { id: "mb4", name: "Work", role: null, parentId: null, sortOrder: 3 });

  return server;
};
