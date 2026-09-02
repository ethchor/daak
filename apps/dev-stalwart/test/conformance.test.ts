import { createJmapClient, createJmapProvider, responseFor } from "@daak/adapter-jmap";
import { accountId, intentId } from "@daak/contracts";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * `@daak/adapter-jmap` against a real server.
 *
 * Everything else in this repo tests the adapter against `test/fake-jmap.ts`,
 * an in-memory server that can produce, on demand, failures a real one will not
 * produce for months: an expired state string, a partial `SetError`, a
 * transport that dies mid-write. That is worth a great deal and it is not
 * conformance — a fake agrees with whatever the adapter believes, because the
 * same person wrote both.
 *
 * This suite is the disagreement. It runs against Stalwart, and it is opt-in:
 * without `DAAK_STALWART_URL` it skips, because CI has no mail server and a
 * suite that fails when a container is absent stops being read.
 *
 *     cd apps/dev-stalwart && docker compose up -d
 *     pnpm --filter @daak/dev-stalwart conformance
 *
 * Fixtures are arranged with the raw JMAP client rather than through
 * `MailProvider`, deliberately. The provider surface is the thing under test,
 * and it has no "put this message on the server" operation that is not also a
 * send — `draft.save` is the week-4 compose lane. Arranging state one level
 * below the seam is how a conformance suite avoids testing its own setup.
 */
const sessionUrl = process.env.DAAK_STALWART_URL;
const credentials = process.env.DAAK_STALWART_AUTH ?? "admin:daak-dev-not-a-real-secret";
const authorization = () => `Basic ${Buffer.from(credentials).toString("base64")}`;

const describeMaybe = sessionUrl === undefined ? describe.skip : describe;

const rawMessage = (id: string, subject: string, body: string): Uint8Array =>
  new TextEncoder().encode(
    [
      `Message-ID: <${id}@seed.daak.test>`,
      "Date: Tue, 1 Sep 2026 09:14:22 +0000",
      "From: Asha Menon <asha@seed.daak.test>",
      "To: admin@seed.daak.test",
      `Subject: ${subject}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      body,
      "",
    ].join("\r\n"),
  );

describeMaybe("adapter-jmap against a real Stalwart", () => {
  const options = { sessionUrl: sessionUrl ?? "", authorization };
  const provider = createJmapProvider({ ...options, accountId: accountId("stalwart") });
  const client = createJmapClient(options);

  let inboxProviderId: string;

  /** Put a message on the server the way another client would have. */
  const arrange = async (id: string, subject: string, body: string): Promise<string> => {
    const raw = rawMessage(id, subject, body);
    const blobId = await client.upload(raw, "message/rfc822");
    const session = await client.session();
    const responses = await client.call([
      [
        "Email/import",
        {
          accountId: session.accountId,
          emails: {
            [id]: {
              blobId,
              mailboxIds: { [inboxProviderId]: true },
              keywords: { $seen: true },
              receivedAt: "2026-09-01T09:14:22Z",
            },
          },
        },
        "import",
      ],
    ]);
    const created = responseFor(responses, "import").created as Record<
      string,
      { id?: string } | undefined
    >;
    const providerId = created[id]?.id;
    if (providerId === undefined) {
      throw new Error(`the server refused the import: ${JSON.stringify(responses)}`);
    }
    return providerId;
  };

  beforeAll(async () => {
    const mailboxes = await provider.listMailboxes();
    const inbox = mailboxes.find((mailbox) => mailbox.role === "inbox") ?? mailboxes[0];
    if (inbox === undefined) throw new Error("the server reported no mailboxes at all");
    inboxProviderId = inbox.providerId;
  });

  it("reads capabilities off the session resource", async () => {
    const capabilities = await provider.capabilities();
    expect(capabilities.maxObjectsPerFetch).toBeGreaterThan(0);
    expect(capabilities.supportsIncrementalChanges).toBe(true);
    // Blob upload is what send and draft-save need. If a real server does not
    // offer it, the compose lane needs to know now and not in week 4.
    expect(capabilities.supportsBlobUpload).toBe(true);
  });

  it("maps the server's own mailbox roles onto ours", async () => {
    const mailboxes = await provider.listMailboxes();
    expect(mailboxes.length).toBeGreaterThan(0);
    // The role vocabulary is the contract's, not JMAP's. A role we do not know
    // must arrive as `none`, never as the server's own string.
    for (const mailbox of mailboxes) {
      expect([
        "inbox",
        "archive",
        "drafts",
        "sent",
        "trash",
        "junk",
        "all",
        "snoozed",
        "none",
      ]).toContain(mailbox.role);
    }
    expect(mailboxes.some((mailbox) => mailbox.role === "inbox")).toBe(true);
  });

  it("starts a tail from now, and reports no history", async () => {
    await arrange("tail-history", "Already here", "This must not be replayed.");
    // A null cursor must not replay the mailbox. Getting this wrong turns a
    // first sync into a flood down the lane least able to carry it.
    const batch = await provider.changes({ collection: "message", cursor: null, limit: 50 });
    expect(batch.changes).toEqual([]);
    expect(batch.cursor).not.toBe("");
    expect(batch.hasMore).toBe(false);
  });

  it("returns raw bytes untouched, so the digest matches the server's", async () => {
    const body = "Bytes in, bytes out.";
    const providerId = await arrange("round-trip", "Conformance round trip", body);
    const fetched = await provider.fetchRaw(providerId);
    // Seam rule 4. A server that renormalised newlines would change the digest,
    // and content-addressed storage would hold the same message twice for ever.
    expect(new TextDecoder().decode(fetched)).toEqual(
      new TextDecoder().decode(rawMessage("round-trip", "Conformance round trip", body)),
    );
  });

  it("reports metadata in the contract's shape, not JMAP's", async () => {
    const providerId = await arrange("metadata", "Metadata shape", "Body.");
    const [metadata] = await provider.fetchMetadata([providerId]);
    expect(metadata?.providerId).toBe(providerId);
    expect(metadata?.mailboxProviderIds).toContain(inboxProviderId);
    expect(metadata?.keywords).toContain("$seen");
    expect(metadata?.size).toBeGreaterThan(0);
    // A tombstone is a null blob id; a live message must have one.
    expect(metadata?.providerBlobId).not.toBeNull();
  });

  /**
   * Skipped, and the reason is a finding rather than an excuse.
   *
   * `Email/query` fails on this server with `serverUnavailable` for every
   * argument list — filtered, unfiltered, sorted, unsorted — while `Email/get`
   * and `Email/changes` on the same account work. The account here belongs to
   * `STALWART_RECOVERY_ADMIN`, which is a fallback principal rather than a
   * provisioned mailbox, and provisioning a real one needs Stalwart 0.16's
   * admin web UI (see this app's README).
   *
   * So `backfill` — the entire historical lane — has still never run against a
   * real server. That is the single most valuable thing left in this lane and
   * it is blocked on account provisioning, not on the adapter.
   */
  it.skip("walks history by receivedAt rather than by position", async () => {
    await arrange("backfill-1", "First", "One.");
    await arrange("backfill-2", "Second", "Two.");
    const first = await provider.backfill({
      collection: "message",
      lowWatermark: null,
      limit: 1,
    });
    expect(first.items.length).toBe(1);
    expect(first.lowWatermark).not.toBeNull();

    const second = await provider.backfill({
      collection: "message",
      lowWatermark: first.lowWatermark,
      limit: 1,
    });
    // Position paging silently skips a message every time new mail arrives at
    // the top, which during a first sync is exactly when it arrives.
    const firstId = first.items[0]?.providerId;
    expect(second.items[0]?.providerId).not.toBe(firstId);
  });

  it("applies a keyword change and reports it back", async () => {
    const providerId = await arrange("keywords", "Flag me", "Body.");
    const outcomes = await provider.apply([
      {
        intentId: intentId("conformance-flag-1"),
        mutation: {
          kind: "keywords.change",
          providerIds: [providerId],
          add: ["$flagged"],
          remove: [],
        },
      },
    ]);
    expect(outcomes[0]?.status).toBe("applied");

    const [after] = await provider.fetchMetadata([providerId]);
    expect(after?.keywords).toContain("$flagged");
    // A patch, not a whole-object update: `$seen` was set by another client and
    // has to survive our write.
    expect(after?.keywords).toContain("$seen");
  });

  it("treats a repeated destroy as applied, not rejected", async () => {
    // JMAP has no idempotency key, so a retry after an ambiguous failure
    // re-sends the destroy and the server answers notFound — because the first
    // one worked. Calling that a rejection resurrects a message the user
    // deleted, which is the most expensive way to get this wrong.
    const providerId = await arrange("destroy", "To be destroyed", "Gone shortly.");

    const first = await provider.apply([
      {
        intentId: intentId("conformance-destroy-1"),
        mutation: { kind: "message.destroy", providerIds: [providerId] },
      },
    ]);
    expect(first[0]?.status).toBe("applied");

    const second = await provider.apply([
      {
        intentId: intentId("conformance-destroy-2"),
        mutation: { kind: "message.destroy", providerIds: [providerId] },
      },
    ]);
    expect(second[0]?.status).toBe("applied");
  });

  it("reports a change after a mutation, so the tail sees other clients", async () => {
    const before = await provider.changes({ collection: "message", cursor: null, limit: 50 });
    await arrange("tail-new", "Tail me", "New mail.");

    const after = await provider.changes({
      collection: "message",
      cursor: before.cursor,
      limit: 50,
    });
    expect(after.changes.length).toBeGreaterThan(0);
    expect(after.cursor).not.toBe(before.cursor);
    expect(after.changes.some((change) => change.kind === "created")).toBe(true);
  });

  it("rejects a move into a mailbox that does not exist", async () => {
    // `rejected`, not `unknown`: the server refused and will refuse again, so
    // the engine must roll the optimistic change back rather than retry for
    // ever. An engine that has never seen a rejection has never had to walk
    // its optimistic state back.
    const providerId = await arrange("bad-move", "Move me nowhere", "Body.");
    const outcomes = await provider.apply([
      {
        intentId: intentId("conformance-badmove-1"),
        mutation: {
          kind: "mailboxes.change",
          providerIds: [providerId],
          add: ["definitely-not-a-mailbox"],
          remove: [],
        },
      },
    ]);
    expect(outcomes[0]?.status).toBe("rejected");
  });

  it("never turns an unusable cursor into a permanent failure", async () => {
    /**
     * The invariant that matters, and a finding underneath it.
     *
     * RFC 8620 §5.2 says a `sinceState` the server cannot use must come back as
     * `cannotCalculateChanges`, which the adapter maps to a conflict so the
     * engine resynchronises. Stalwart does not do that: a state string it can
     * parse but has never issued is treated as an early state and it replays
     * from there, and one it cannot parse at all comes back as
     * `invalidArguments`. Neither is the spec's answer.
     *
     * Replaying converges, so it is survivable — but only because the one
     * outcome that would not converge is ruled out here. `permanent` is what
     * stops an account syncing for ever with no way back, and no cursor the
     * server dislikes may ever produce it.
     */
    const outcome = await provider
      .changes({ collection: "message", cursor: "not-a-real-state", limit: 50 })
      .then(
        (batch) => ({ ok: true as const, batch }),
        (error: unknown) => ({ ok: false as const, error }),
      );

    if (outcome.ok) {
      expect(outcome.batch.cursor).not.toBe("");
    } else {
      expect(outcome.error).not.toMatchObject({ kind: "permanent" });
    }
  });
});
