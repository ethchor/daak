# @daak/sync — Lane A, week 2. Deep review required.

The reconciliation engine. This is the package where agent-written code is most
likely to be plausibly wrong: correct-looking, passing the obvious tests, and
corrupting state on the third reconnect.

**Write the property tests first. Get them reviewed. Then implement against them.**

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

## Test

    pnpm --filter @daak/sync test
