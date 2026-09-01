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
| Tech stack decided | ✅ Done, except the licence |

### What is genuinely finished

The interfaces, the persisted shapes, the error taxonomy and the capability
model, with 42 tests covering them. The corpus loader and its integrity checks.
The stack decisions, each with a revisit trigger.

### What is only started

**The corpus.** 22 messages against a target of 300+. They cover every category
the plan names, so the *shape* is right, but coverage inside each category is
thin — `malformed` in particular, which is where parsers actually fail.
`tools/import-mbox.ts` exists to grow it from public archives; each import needs
its expectations filled in by hand.

**CI performance budgets.** The numbers are written down in `ARCHITECTURE.md`.
Nothing measures them yet, because nothing exists to measure.

## Week 1 — pure lanes

| Lane | Package | State |
|---|---|---|
| A | `mime` | Not started. Scoped in its `CLAUDE.md` |
| B | `threading` | Not started. Scoped |
| C | `store` | Not started. Scoped |
| D | `adapter-mock` | Not started. Scoped — **start here**, weeks 2–4 depend on it |

## Weeks 2–4

Not started. See the plan.

## Open decisions

| Decision | Blocking | Owner |
|---|---|---|
| Licence (Apache-2.0 for contracts + AGPL-3.0 for the rest, vs uniform permissive) | Nothing yet; blocks going public | Owner |
| MIME library choice (`postal-mime` vs alternatives) | Week 1 lane A | Decide by evaluating against the corpus |

## Known gaps worth naming

- No adapter has ever spoken to a real server. `apps/dev-stalwart`'s compose
  file is written but unvalidated.
- The eight seams have one implementation each at most. The plan calls for two
  by day 30, which is what proves an abstraction rather than assuming it.
- Nothing has been profiled. Every performance claim in this repo is currently a
  budget, not a measurement.
