# dev-stalwart

A local JMAP mail server to develop against, a deterministic mailbox seeder, and
the performance harness.

Week 2, lane D. It exists because two claims elsewhere in this repo could not be
checked without it — that the JMAP adapter works against a real server, and that
a query is fast against a real mailbox. Both were assertions. This turns them
into measurements, and says plainly where it fell short.

## The server

    cp .env.example .env
    docker compose up -d

Then the JMAP session resource is at `http://127.0.0.1:8080/jmap/session`, and
the credentials are `admin` plus whatever is in `.env`.

Validated against `stalwartlabs/stalwart:0.16.20`. Four things in the compose
file are not obvious and were each arrived at by watching it fail:

**`config.json` is a data-store pointer, not a settings file.** In 0.16 the file
at `/etc/stalwart/config.json` says only where the database is; every other
setting lives inside that database. A TOML config — which most of the
documentation online still shows — is rejected with a JSON parse error, and a
settings-shaped JSON is rejected with `missing field \`@type\``. Neither message
mentions the change. This is why `STALWART_VERSION` is pinned.

**The data directory must exist and be owned by uid 2000.** Stalwart runs as
`stalwart` (2000) and does not create `/opt/stalwart/data` itself, while a Docker
named volume arrives root-owned. The failure is `unable to open database file`,
which reads like a corrupt volume. The `init` service is there only for this.

**`STALWART_PUBLIC_URL` is required.** The session resource advertises absolute
URLs, built from the server's hostname — which in a container is the container
id. Without this a client reads the session, is handed
`https://8676415e3a5/jmap/`, and fails DNS. It is the one line that makes the
server reachable from outside its own network namespace.

**`STALWART_RECOVERY_ADMIN` avoids the bootstrap flow.** With no configuration
Stalwart starts in bootstrap mode, prints a one-time password, and waits for an
administrator to finish setup in a web UI that it downloads from GitHub on
first request. That is a poor fit for a dev container and an impossible one for
an air-gapped CI runner. Pinning an administrator skips it.

Listeners inside the container, confirmed rather than assumed: 8080 (HTTP), 443
(HTTPS, self-signed), 25, 465, 993, 4190. **Not** 143 or 587 — an earlier
version of this file mapped those and they do not exist.

### What this does not get you

**A provisioned account.** `STALWART_RECOVERY_ADMIN` is a fallback principal,
not a mailbox with a domain behind it. Most of JMAP works against it —
`Email/get`, `Email/set`, `Email/import`, `Email/changes`, `Mailbox/get`,
upload and download all do — but `Email/query` returns `serverUnavailable` for
every argument list, which means `backfill` cannot be exercised.

Provisioning a real account means Stalwart's admin web UI. There is no
management REST API to script against in 0.16: the UI drives the server over
JMAP itself, against object types published at `/api/schema`, and the settings
endpoints from 0.15 are gone. Closing this is the most valuable thing left here.

## Conformance

    docker compose up -d
    DAAK_STALWART_URL=http://127.0.0.1:8080/jmap/session \
      pnpm --filter @daak/dev-stalwart conformance

`test/conformance.test.ts` runs `@daak/adapter-jmap` against the real server. It
skips silently without `DAAK_STALWART_URL`, because CI has no mail server and a
suite that goes red when a container is absent stops being read.

It is the counterweight to `packages/adapter-jmap/test/fake-jmap.ts`. A fake is
worth a great deal — it produces expired cursors and partial `SetError`s on
demand, which a real server will not do for months — but it agrees with whatever
the adapter believes, because the same person wrote both. This suite is where
they can disagree.

Ten of eleven checks pass. What it found:

- The session's advertised URLs are not necessarily reachable (above).
- `draft.save` is unimplemented in the adapter and falls through a `default:`
  branch that reports **`applied`**. Nothing reaches it today because `@daak/sync`
  refuses that intent, but an unimplementable mutation reporting success would
  make the engine mark the intent done and drop the user's draft silently. Raised
  for `@daak/adapter-jmap`; not fixed here, because a change to another package
  belongs to its owner.
- An unusable cursor does not produce `cannotCalculateChanges`. Stalwart replays
  from an early state for one it can parse, and answers `invalidArguments` for
  one it cannot. Neither is RFC 8620 §5.2. Replaying converges, so the suite
  asserts the invariant that actually matters — that no cursor the server
  dislikes is ever reported as `permanent`, which is the one outcome an account
  cannot recover from.

## Seeded mailboxes

    pnpm --filter @daak/dev-stalwart seed 50k --out ./seed-50k.sqlite
    pnpm --filter @daak/dev-stalwart bench 50k

Three sizes, because the interesting problems only appear at the largest:

| Size | For |
|---|---|
| 1k | Everyday development. Fast to reset. |
| 50k | Search relevance and index build times. |
| 500k | The performance budgets in `ARCHITECTURE.md`. |

Everything is written through the event log, exactly as a sync would write it.
Seeding projections directly would be far faster and would measure a code path
that does not exist.

### What makes the corpus worth measuring against

500k copies of one message is not a 500k mailbox. An index over one repeated
body is a fraction of its real size, every term is either ubiquitous or absent,
and bm25 has nothing to discriminate on — so every number taken against it
flatters the code. `population.ts` holds the distributions that prevent that,
and `vocabulary.ts` the long tail of terms that makes the index realistic.

The whole fixture corpus rides along in every seeded mailbox, **once**. The plan
asks that seeded mail draw its shapes from `@daak/fixtures`; at a rate, 5% of
500k would be twenty-five thousand copies of twenty-two messages collapsing into
twenty-two enormous threads, which would distort every threading and ranking
number afterwards. Once, they are exercised without skewing a distribution.

Two honest limits:

- **Attachments are far smaller than life** (`attachmentBytes`, 3KB by default).
  Real mail is tens of kilobytes and a real 500k mailbox is tens of gigabytes.
  The default trades attachment bytes, which only the blob store cares about,
  for message count, which is what everything else scales against.
- **The distributions are plausible, not measured.** Nobody has profiled a real
  mailbox to produce them. They are in one file so a better source replaces them
  in one edit.

The corpus is anchored to a fixed `endsAt` rather than the clock. Seeding
against `Date.now()` produces a different mailbox every run, which quietly
destroys the one property the seeder exists to provide.

## The harness

`bench.ts` measures the five interaction budgets in `ARCHITECTURE.md`. Two
things must be said with any number it prints, and it prints them itself:

**They are interaction budgets and there is no interface yet.** What is measured
is the query underneath, which is a floor. Rendering, IPC and the framework's
own work all come out of the same 50ms and none of it is counted.

**They are not comparable across machines.** A laptop on battery and a CI runner
are different numbers. Nothing here asserts a threshold; wiring this in as a CI
gate is week 3 and needs a runner whose variance is known.

## Not yet done

- Account provisioning, and therefore `backfill` conformance (above).
- The 500k seed. See `docs/STATUS.md` for the measured cost of 50k and why 500k
  is not a matter of waiting ten times as long.
- IMAP, when that adapter exists. The ports are mapped.
- A one-command "Daak + Stalwart" compose for self-hosters — days 60–90, and
  what makes self-hosting actually spread.
