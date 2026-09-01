# @daak/sync — Lane A, week 2. Deep review required.

The reconciliation engine. This is the package where agent-written code is most
likely to be plausibly wrong: correct-looking, passing the obvious tests, and
corrupting state on the third reconnect.

**Write the property tests first. Get them reviewed. Then implement against them.**
That is how this package was built: `test/convergence.test.ts` and the public
surface in `src/types.ts` were committed before a line of `engine.ts` existed.

## The properties, before any implementation

For any sequence of local mutations and any injected fault pattern, local state
converges to server state after reconnect. Use `fast-check` and
`@daak/adapter-mock`'s fault injector. That one property catches the entire
class of bug this package exists to avoid.

## Rules

- **Single writer per account.** No concurrent mutation of account state.
- **Two independent lanes.** Live tail and historical backfill. Backfill never
  blocks the tail; a stalled backfill must not stop new mail arriving.
- **Intent log.** Local mutations are appended, applied optimistically, then
  pushed. On rejection, replay and reconcile. Local and remote are never one
  transaction.
- **Flags are last-write-wins per flag. Labels are observed-remove sets. Bodies
  are immutable.**
- **Every mutation is idempotent and carries a client-generated id**, so a retry
  after an ambiguous failure is safe.

## Two bugs the properties caught, and what they mean

Both were found by the convergence property on its first runs, and neither would
have appeared in any example test.

**A stale read silently loses a change for ever.** The tail fetched metadata
while the server was still serving pre-mutation state, wrote that stale state
locally, and advanced the cursor past the change. The change was then invisible:
its sequence number was behind the cursor, so the change feed would never mention
it again.

The fix is that the engine no longer trusts the change feed to tell it about its
*own* writes. Every message an intent touched becomes unverified, and it leaves
that set only when two consecutive reads agree — a stale read disagrees with the
fresh one after it and costs a round rather than a permanent divergence. Against
an honest server that is one extra fetch per mutated message; against a lying one
it is the difference between converging and not.

**A refresh after a delete deadlocked.** Reconciling a destroyed message fetched
its metadata, found no local copy, and asked for its bytes — which the provider
no longer has. A tombstone reported by a metadata read is not new mail. Both
`ingest` and `refresh` now treat a null `providerBlobId` as exactly that.

## The specific failure mode to grep for

The request that timed out but succeeded server-side. It is not a failure and it
is not a success — it is `unknown`, and it resolves by observing server state,
never by blindly resending. Every code path that handles a provider error must
account for it explicitly. If a branch handles the happy path and one error
case, it is wrong.

## Allowed imports

`@daak/contracts`, `@daak/store`, `@daak/mime`, `@daak/threading`.

## Forbidden

- Importing any concrete adapter. The engine talks to `MailProvider` and
  nothing else; tests use `@daak/adapter-mock`.
- `setTimeout` for anything but backoff, and backoff must be injectable so tests
  do not sleep.
- Any code path where a provider error is swallowed.

## Known limits, so nobody rediscovers them as bugs

- **Local ids derive from provider ids** (`src/ids.ts`). Stable for JMAP, and a
  problem for IMAP: a UIDVALIDITY change renumbers a mailbox and every message
  would look new. The IMAP adapter has to absorb that below the boundary.
- **`draft.save` and `message.send` are refused**, loudly. They need
  `uploadBlob` + `submit`, which is the week-4 compose lane. A silent no-op
  would leave an intent pending for ever.
- **Threads are recomputed for the whole account on every projection batch.**
  Fine at 1k, not at 500k. Incremental threading is a week-3 problem.

## Test

    pnpm --filter @daak/sync test
