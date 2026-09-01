# @daak/adapter-mock — Lane D, week 1. The most important week-1 deliverable.

A deterministic in-memory `MailProvider` plus a fault injector. Every subsequent
lane tests against this: no credentials, no flakiness, no rate limits,
reproducible failures.

Give it your second-best attention after the sync engine. Weeks 2–4 are only
parallelisable because this exists.

## Done when

It can replay a scripted session with injected disconnects, reordered responses,
duplicated events, and stale cursors — and the same seed always produces the
same run.

## Faults it must be able to inject

- Disconnect mid-response.
- **Apply the mutation, then fail the response.** The ambiguous case. If the
  mock cannot produce this, the sync engine cannot be tested for the bug it is
  most likely to have.
- Duplicate an event.
- Reorder a batch.
- Expire a cursor and demand a resynchronise.
- Rate-limit with a `Retry-After`.
- Return a stale read after a write.

## Rules

- Seeded PRNG. Never `Math.random()`. A failing test must reproduce from its
  seed alone.
- No wall-clock time. Tests must not sleep.
- Faithful to the contract, not to any real server's bugs — this implements
  `MailProvider` as specified, which is what makes it a conformance test for
  the interface as much as a test double.

## Allowed imports

`@daak/contracts`, `@daak/fixtures`.

## Test

    pnpm --filter @daak/adapter-mock test
