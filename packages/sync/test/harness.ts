import { createMockProvider, type MockProvider } from "@daak/adapter-mock";
import { type AccountId, accountId, type Instant } from "@daak/contracts";
import { parseMessage } from "@daak/mime";
import type { MessageFields, Projectors } from "@daak/store";
import { createNodeDriver, openStore, type Store } from "@daak/store";
import { threadMessages } from "@daak/threading";
import { createSyncEngine } from "../src/engine.js";
import { localMailboxId, providerIdOf } from "../src/ids.js";
import type { SyncEngine } from "../src/types.js";

export const ACCOUNT: AccountId = accountId("acct");

export const projectors: Projectors = {
  async resolveMessage(raw): Promise<MessageFields> {
    const parsed = await parseMessage(raw);
    return { ...parsed.envelope, hasAttachment: parsed.hasAttachment, preview: parsed.preview };
  },
  threadMessages: (input) => threadMessages(input),
};

export const rawMessage = (id: string, subject = "Quarterly numbers"): string =>
  `Message-ID: <${id}@example.org>\r\nFrom: Asha <asha@example.org>\r\nTo: you@example.net\r\nSubject: ${subject}\r\nDate: Mon, 3 Aug 2026 09:14:22 +0000\r\nContent-Type: text/plain; charset=us-ascii\r\n\r\nBody of ${id}.\r\n`;

export interface Rig {
  readonly engine: SyncEngine;
  readonly provider: MockProvider;
  readonly store: Store;
  close(): void;
}

export const makeRig = (options: { seed?: string | number; messages?: number } = {}): Rig => {
  const provider = createMockProvider({
    accountId: ACCOUNT,
    seed: options.seed ?? "sync",
    maxObjectsPerFetch: 3,
  });
  for (let i = 1; i <= (options.messages ?? 0); i++) {
    provider.server.addMessage({ raw: rawMessage(`m${i}`), providerId: `P${i}` });
  }

  const store = openStore({ driver: createNodeDriver(), projectors });
  store.migrate();

  let tick = 0;
  const engine = createSyncEngine({
    accountId: ACCOUNT,
    provider,
    store,
    pageSize: 3,
    // No sleeping, ever: a property test that waits is a property test nobody
    // runs ten thousand times.
    backoff: () => 0,
    now: () => new Date(Date.UTC(2026, 8, 1, 0, 0, tick++)).toISOString() as Instant,
  });

  return {
    engine,
    provider,
    store,
    close() {
      store.close();
    },
  };
};

/**
 * Local state, in the shape the mock server reports its own.
 *
 * Convergence means these two are equal. Comparing anything less — an intent
 * count, a "no errors" flag — is comparing the client against itself.
 */
export const localSnapshot = (
  store: Store,
): Record<string, { keywords: string[]; mailboxes: string[] }> => {
  const result: Record<string, { keywords: string[]; mailboxes: string[] }> = {};
  for (const message of store.queryMessages({ accountId: ACCOUNT, limit: 10_000 })) {
    result[message.providerId] = {
      keywords: [...message.keywords].sort(),
      // Back to provider ids, so the comparison is like for like.
      mailboxes: message.mailboxIds.map(providerIdOf).sort(),
    };
  }
  return result;
};

/** The server's view, filtered to messages that still exist. */
export const serverSnapshot = (
  provider: MockProvider,
): Record<string, { keywords: string[]; mailboxes: string[] }> => {
  const result: Record<string, { keywords: string[]; mailboxes: string[] }> = {};
  for (const [providerId, state] of Object.entries(provider.server.snapshot())) {
    if (state.destroyed) continue;
    result[providerId] = { keywords: state.keywords, mailboxes: state.mailboxes };
  }
  return result;
};

export { localMailboxId, providerIdOf };
