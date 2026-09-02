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

## What the properties caught, and the two wrong fixes before the right one

None of this would have appeared in an example test, and the wrong turns are
worth keeping because each looked correct.

**A stale read loses a change for ever.** The tail fetched metadata while the
server was still serving pre-mutation state, wrote that stale state, and
advanced the cursor past the change. The change was then invisible: its sequence
number sat behind the cursor, so the change feed would never mention it again. A
user's archive silently un-archives itself and nothing ever puts it right.

*First fix, wrong:* believe a read once a second read agrees with it. The
property demolished it — a server that serves three stale reads in a row gives
you two stale reads that agree **with each other**. Repetition is not evidence.

*Second fix, still wrong:* check reads against what we asked for, but only while
verifying. The verification refresh read fresh data and cleared itself; then the
tail's own fetch came back stale and overwrote it. Verifying a value you then
allow something else to overwrite is not verification.

*What works:* an expectation **filters every write**. When the provider says an
intent applied, any later read that contradicts it is discarded as stale, on all
paths, and the message stays unsatisfied so it is read again. A read budget ends
the argument — after enough contradicting reads we accept the server, because a
stale read and another client genuinely undoing the change are indistinguishable
from here.

**A refresh after a delete deadlocked.** Reconciling a destroyed message fetched
its metadata, found no local copy, and asked for its bytes — which the provider
no longer has, so `settle` spun to its round limit. A tombstone in a metadata
read is not new mail. Both `ingest` and `refresh` treat a null `providerBlobId`
as exactly that.

## Soak this package before pushing

    pnpm soak

`pnpm preflight` runs the tests once, because that is what CI does — and once is
not enough for a property suite. Each run explores a different slice of the
input space. The second wrong fix above passed 200 property cases locally and
failed on its first CI run, on a real counterexample. Ten soak runs is about two
thousand cases and takes under a minute.

Pin every counterexample you fix into the property's `examples`, so it is
checked on every run rather than when a seed happens to rediscover it.

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
