# @daak/adapter-jmap — Lane B, week 2

JMAP provider, RFC 8620 (core) and RFC 8621 (mail). Well-specified, which makes
it good agent work — but validate against a real Stalwart, not just the spec.

## Done when

The same conformance suite that `adapter-mock` passes also passes here against
`apps/dev-stalwart`, including cursor expiry and partial-batch failures.

**Not done yet.** This has never spoken to a real server. `test/fake-jmap.ts` is
an in-memory JMAP server over an injected `fetch`, and it makes the interesting
failures reachable — an expired state string, a partial `SetError`, a transport
that dies mid-write — which no real server produces on demand. That is worth a
great deal and is not the same thing as conformance. Validating against Stalwart
is week 2 lane D.

## Rules

- **No JMAP vocabulary leaves this package.** No `Email/get`, no `/query`, no
  JMAP state strings in any type that crosses the boundary. State strings become
  opaque `cursor` values.
- Use `Foo/changes` for the tail lane and `Foo/query` for backfill. Never poll
  a full query for the tail.
- Batch to the server's advertised `maxObjectsInGet`, not to a number you chose.
- Map every JMAP `SetError` type onto the error taxonomy explicitly. A default
  branch that returns `permanent` for an unrecognised error type will strand
  intents.
- `stateMismatch` is `conflict`, not `permanent`. Getting this wrong means the
  engine never resynchronises.

## Allowed imports

`@daak/contracts`, `fetch`. No JMAP client library — the protocol is JSON over
HTTP, and we want exact control of state strings and batching.

## Decisions worth knowing before changing them

**A null cursor means "start from now".** `changes()` returns the server's
current state string and no changes. History is backfill's job — a tail that
replays the mailbox turns a first sync into a flood through the lane least able
to carry it.

**Backfill walks by `receivedAt`, not by position.** Position-based paging
silently skips a message every time new mail arrives at the top, and during a
first sync that is exactly when it arrives.

**One `Email/set` call per intent**, batched to `maxCallsInRequest`. Merging
intents into a single call makes a partial failure impossible to attribute, and
attribution is the whole point: the engine has to know which of the user's
changes landed.

**Patches, never whole-object updates.** `keywords/$seen: true` leaves every
other keyword alone. Sending a complete set risks wiping a keyword another
client added between our read and our write.

**A repeated destroy is `applied`, not `rejected`.** JMAP has no idempotency
key, so a retry after an ambiguous failure re-sends the destroy and the server
answers `notFound` — because the first attempt worked. Calling that a rejection
makes the engine resurrect a message the user deleted.

**`transient` and `conflict` SetErrors produce `unknown`, not `rejected`.**
`rejected` tells the engine to roll the user's change back, so it is only for a
refusal that will still be a refusal next time.

## Known gap: submission is not properly idempotent

JMAP has no idempotency primitive for `EmailSubmission/set`. The adapter
remembers keys for the life of the process, which does not survive a restart. A
transport failure during submission therefore returns `unknown` and never
`rejected` — sending someone's mail twice is worse than any error message.

Closing this properly is a compose-lane problem: search Sent for the
`Message-ID` before re-sending.

## Test

    pnpm --filter @daak/adapter-jmap test
