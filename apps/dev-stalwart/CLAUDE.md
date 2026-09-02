# @daak/dev-stalwart — Lane D, week 2

The development mail server, the mailbox seeder, and the performance harness.

## Done when

`@daak/adapter-jmap` is validated against a real Stalwart, and seeded mailboxes
at 1k / 50k / 500k exist for the performance budgets in `ARCHITECTURE.md`.

**Partly done, and the README says exactly where.** The adapter has now spoken to
a real server and ten of eleven conformance checks pass; `backfill` has not,
because `Email/query` needs a provisioned account and provisioning needs
Stalwart's admin web UI. The seeder and harness work and produce real numbers at
1k and 50k. 500k has not been built.

## Scope

- The compose file, and knowing why every line of it is there.
- Deterministic corpus generation with realistic distributions.
- Seeding a `@daak/store` through the event log.
- Measuring the interaction budgets.
- Conformance: the adapter against a real server.

## Decisions worth knowing before changing them

**The corpus is anchored to a fixed `endsAt`, not the clock.** Seeding against
`Date.now()` gives a different mailbox every run, and a number measured today
stops being comparable with one measured next month. Anything that wants
"recent" — the search ranking's recency boost — takes its reference time as a
parameter and is handed this.

**The fixture corpus rides along once, not at a rate.** At a rate it would
collapse into a handful of enormous threads and distort every measurement taken
afterwards. See the README.

**Seeding writes events, never projections.** It is slower and it is the only
way the numbers mean anything.

**The parse is cached on the byte array.** Each message is needed twice, once
for the message row and once for the full-text document, and parsing dominates
seeding. The seeder supplies `readBlob`, so the projector is handed the very
buffer the generator produced and a `WeakMap` makes the second lookup free.

**Conformance arranges fixtures with the raw JMAP client, below the seam.** The
provider surface is the thing under test and it has no way to put a message on a
server that is not also a send. Setting up one level down is how the suite
avoids testing its own setup.

**Conformance skips without `DAAK_STALWART_URL`.** CI has no mail server. A
suite that goes red when a container is absent stops being read, and a pipeline
people expect to be red has stopped being a signal.

## Rules

- Never assert a performance threshold here. These numbers come from whatever
  machine ran them; a gate needs a runner whose variance is known, and that is
  week 3.
- Report what was measured, including when it is bad. A harness that flatters
  the code is worse than no harness.
- No credential that matters goes in `.env`, the compose file, or a fixture.
  Development passwords only, and they protect nothing.
- A finding about another package is raised, not patched. One agent, one
  package.

## Allowed imports

Everything. It is an app, not a package — it sits above every seam and wires
the real projectors together the way `@daak/sync` does in production.

## Test

    pnpm --filter @daak/dev-stalwart test

    # and, with a server running:
    DAAK_STALWART_URL=http://127.0.0.1:8080/jmap/session \
      pnpm --filter @daak/dev-stalwart conformance
