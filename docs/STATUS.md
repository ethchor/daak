# Status

Where the project actually is, against `docs/BUILD_PLAN.md`. Updated as lanes
land. Written to be honest rather than encouraging — a status document that
overstates is worse than none.

_Last updated: 2026-09-01._

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

**Performance.** Nothing has been profiled. Every number in `ARCHITECTURE.md` is
a budget, not a measurement.

## Week 2 — the engine

Not started. `@daak/sync` is the deep-review lane, and the plan is explicit
about how it gets built: **write the convergence property tests first, get them
reviewed, then implement against them.** The mock's `apply-then-fail` fault is
what those properties get written against.

`adapter-jmap` and `search` do not depend on sync and can run in parallel.

## Open decisions

| Decision | Blocking | Owner |
|---|---|---|
| Does OPFS SQLite hold up at 500k messages across browsers? | Week 1 `store` lane | Spike it before the schema is built on the assumption |
| MIME library choice (`postal-mime` vs alternatives) | Week 1 lane A | Decide by evaluating against the corpus |

## Known gaps worth naming

- No adapter has ever spoken to a real server. `adapter-mock` implements the
  contract faithfully, which is not the same as a real server implementing it
  faithfully. `apps/dev-stalwart`'s compose file is written but unvalidated.
- Threads are recomputed for a whole account on every projection batch. Correct,
  and O(messages) — fine at 1k, not at 500k. Incremental threading is a week-3
  problem, flagged here so it is a known cost rather than a surprise.
- The eight seams have one implementation each at most. The plan calls for two
  by day 30, which is what proves an abstraction rather than assuming it.
- Nothing has been profiled. Every performance claim in this repo is currently a
  budget, not a measurement.
