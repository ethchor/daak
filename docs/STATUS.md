# Status

Where the project actually is, against `docs/BUILD_PLAN.md`. Updated as lanes
land. Written to be honest rather than encouraging — a status document that
overstates is worse than none.

_Last updated: 2026-09-02._

## Week 0 — contracts and fixtures

| Deliverable | State |
|---|---|
| `@daak/contracts` — seams, persisted shapes, error taxonomy, capabilities | ✅ Done |
| `@daak/fixtures` — golden corpus + loader | 🟡 22 of a target 300+ messages |
| `ARCHITECTURE.md` — the invariants | ✅ Done |
| CI from commit one | 🟡 lint/typecheck/test green; performance budgets land in week 3 |
| Tech stack decided | ✅ D-01 to D-17 settled with the owner, licence included |

## Week 1 — pure lanes. Complete.

| Lane | Package | State |
|---|---|---|
| A | `@daak/mime` | ✅ Wraps `postal-mime`; the whole corpus parses. 91 tests |
| B | `@daak/threading` | ✅ JWZ, deterministic, 3 property tests. 39 tests |
| C | `@daak/store` | ✅ Schema, migrations, provable rebuild. 31 tests |
| D | `@daak/adapter-mock` | ✅ Deterministic server, 8 fault kinds. 44 tests |

**247 tests across the repo.**

### What the corpus and the property tests have caught

Three real bugs so far, which is the argument for having built them before the
code they test:

- `postal-mime` reported inline `cid:` images, S/MIME signatures and calendar
  bodies as attachments. Left alone, every newsletter and every signed message
  would have carried a paperclip.
- Threading merged a forward into the conversation it quoted — and worse, became
  the thread a later reply attached to, so "Re: numbers" landed on someone's
  forward rather than the original.
- A store property test found, on its first run, that replaying a
  `keywords.set` after a `message.removed` threw. That would have made the
  account permanently unrebuildable and stayed hidden until the first rebuild.

None of the three would have appeared in a happy-path test.

### What is still thin

**The corpus.** 22 messages against a target of 300+. Every category the plan
names is represented, so the shape is right, but coverage inside each is thin —
`malformed` especially, which is where parsers actually fail.

**Performance.** Now partly measured — see week 2 lane D below. Three of the
five budgets in `ARCHITECTURE.md` are comfortably met at 50k. One is missed by a
factor of forty-seven.

## Week 2 — the engine

| Lane | Package | State |
|---|---|---|
| A | `@daak/sync` | ✅ Tail, backfill, intent log, reconciliation. 8 tests, 200 property runs |
| B | `@daak/adapter-jmap` | ✅ Full MailProvider over RFC 8620/8621. 48 tests |
| C | `@daak/search` | ✅ FTS5 index, query grammar, recency ranking. 48 tests |
| D | `apps/dev-stalwart` | 🟡 Server validated, adapter conformance 10/11, mailboxes seeded and measured |

`sync` was built tests-first, as the plan requires for this lane: the public
surface and the convergence properties were committed before a line of the
engine existed.

### Lane D, and the two caveats it was built to lift

**"No adapter has ever spoken to a real server" is no longer true.**
`@daak/adapter-jmap` now runs against Stalwart 0.16.20 in
`apps/dev-stalwart/test/conformance.test.ts`, and ten of eleven checks pass:
capabilities, role mapping, a tail that starts from now, byte-identical raw
fetch, metadata shape, a keyword patch that preserves another client's flag, a
repeated destroy reported as applied, a change visible after a mutation, and a
move into a missing mailbox reported as `rejected`.

The eleventh — `backfill` — is skipped, and that is the honest headline: it has
still never run against a real server. `Email/query` returns `serverUnavailable`
for every argument list on the recovery-admin account, which is a fallback
principal rather than a provisioned mailbox. Provisioning one needs Stalwart
0.16's admin web UI; there is no management REST API left to script. Closing
that is the most valuable thing remaining in this lane.

**"No query has run against a large mailbox" is no longer true either, and the
result is worse than expected.** Numbers below.

### What the convergence property caught

Two bugs, both on early runs, neither of which any example test would have
found:

- **A stale read lost a change permanently.** The tail stored pre-mutation state
  *and* advanced the cursor past the change, putting it behind the cursor for
  good. A user's archive would silently un-archive itself and nothing would ever
  correct it. The engine now holds every message it mutated as unverified until
  two consecutive reads agree.
- **A refresh after a delete deadlocked**, asking a provider for bytes it no
  longer had, until `settle` hit its round limit.

### What the seeded mailboxes measured

`linux/x64`, node 22.22.2, in a container. Not comparable with any other
machine, which is why nothing asserts a threshold yet.

| Interaction | Budget | p50 | p95 | Within |
|---|---|---|---|---|
| Mailbox switch (50k) | 50ms | 2.6ms | 8.3ms | yes |
| Open thread, cached (50k) | 50ms | 0.0ms | 0.0ms | yes |
| Cold start → first list (50k) | 1s | 1.9ms | 5.5ms | yes |
| Keystroke → list update (20k) | 50ms | 0.2ms | 0.3ms | yes |
| **Local search, first results (20k)** | **150ms** | **7,100ms** | **8,499ms** | **no** |

Every row is the query alone. There is no interface yet, so rendering, IPC and
the framework's own work are all excluded and all come out of the same budget.

### Two findings, both in `@daak/search`, both with the same root

Neither would have appeared below about ten thousand messages, which is the
entire argument for this lane.

**1. `has:attachment after:… <term>` is 47× over budget, because the join order
inverts.** A bare term is 0.2ms. Add a date or flag filter and SQLite stops
driving the query from the full-text index and starts driving it from
`messages_by_received`, re-running the `MATCH` once per candidate row:

    SEARCH m USING INDEX messages_by_received (account_id=? AND received_at>?)
    SCAN message_fts VIRTUAL TABLE INDEX 0:M6

Twenty thousand FTS searches to answer one query. It is exactly the query in
lane C's own done-criterion.

**2. Building the index is quadratic.** Time to index, by message count:
2k→0.8s, 4k→2.9s, 8k→11.1s, 16k→57.6s. Four times the work for twice the mail.
Seeding 50k takes 75 seconds with the index off and was killed at 24 minutes
with it on.

The cause is one line of schema. `message_fts.message_id` is `UNINDEXED`, which
in FTS5 means it is stored but carries no b-tree — so
`delete from message_fts where message_id = ?` is a full scan of the index, and
the writer does one per message to get idempotence. Measured directly: 200
deletes cost 114ms at 2k rows, 506ms at 8k, 2,695ms at 32k, while 200 inserts
stay flat at 7ms, 12ms, 18ms.

The same `UNINDEXED` column is why finding 1's join has nothing to seek on.

Both are raised rather than fixed: `@daak/search` is another package, and the
likely repair — a shadow table, or FTS5 external-content with a rowid mapping —
needs a migration in `@daak/store` as well. That spans two packages, so it goes
to their owners with this reproduction rather than into lane D's diff.

**372 tests across the repo**, plus 11 conformance checks that need a server.

## Open decisions

| Decision | Blocking | Owner |
|---|---|---|
| Does OPFS SQLite hold up at 500k messages across browsers? | Week 1 `store` lane | Spike it before the schema is built on the assumption |
| MIME library choice (`postal-mime` vs alternatives) | Week 1 lane A | Decide by evaluating against the corpus |

## Known gaps worth naming

- **`backfill` has never spoken to a real server.** The rest of the provider
  seam now has (above). This one is blocked on account provisioning, not on the
  adapter.
- **`draft.save` reports `applied` without doing anything.** It falls through
  the `default:` branch of `@daak/adapter-jmap`'s mutation switch, which issues
  an empty `Email/get`. Nothing reaches it today because `@daak/sync` refuses
  that intent — but an unimplementable mutation reporting success would make the
  engine mark the intent done and drop a user's draft in silence. Found by
  conformance; raised for that package's owner.
- **An unusable cursor is not reported as `cannotCalculateChanges`.** Stalwart
  replays from an early state for a cursor it can parse and answers
  `invalidArguments` for one it cannot; RFC 8620 §5.2 asks for neither.
  Replaying converges, so it is survivable, and the conformance suite pins the
  invariant that actually matters — no cursor the server dislikes may ever be
  reported as `permanent`, which is the one outcome an account cannot recover
  from.
- JMAP submission is not properly idempotent, because JMAP offers no primitive
  for it. The adapter remembers keys for the life of the process only, so an
  ambiguous send returns `unknown` and never `rejected`. Closing it properly
  means searching Sent for the `Message-ID` before re-sending — a compose-lane
  problem.
- Threads are recomputed for a whole account on every projection batch. Correct,
  and O(messages) — fine at 1k, not at 500k. Incremental threading is a week-3
  problem, flagged here so it is a known cost rather than a surprise.
- `sync` refuses `draft.save` and `message.send`. They need `uploadBlob` plus
  `submit`, which is the week-4 compose lane; refusing loudly beats a silent
  no-op that strands an intent for ever.
- Local ids derive from provider ids, which is stable for JMAP and not for IMAP,
  where a UIDVALIDITY change renumbers a mailbox. The IMAP adapter has to absorb
  that below the boundary.
- The eight seams have one implementation each at most. The plan calls for two
  by day 30, which is what proves an abstraction rather than assuming it.
- The 500k mailbox has not been built. At 50k the seeder takes 75 seconds with
  the index off; with it on, the quadratic writer above makes 500k impractical
  until that is fixed, so the largest size in the plan is still theoretical.
- Attachments in the seeded corpus are 3KB, far below life. Blob-store I/O is
  therefore understated and no number here should be read as if the bodies were
  life-sized.
- The measured numbers come from one container. Nothing asserts a threshold, and
  a CI gate needs a runner whose variance is known — that is week 3.
