# Status

Where the project actually is, against `docs/BUILD_PLAN.md`. Updated as lanes
land. Written to be honest rather than encouraging — a status document that
overstates is worse than none.

_Last updated: 2026-09-01._

## The stack decision, and what it costs

On 2026-09-01 the owner reviewed the stack and changed D-01: **the core is Rust,
the client is TypeScript.** That is the right call for the engine and it is not
free. What it does to work already done:

| Built | Fate |
|---|---|
| `packages/fixtures` — 22-message corpus, expectations, loader, importer | **Survives untouched.** `.eml` and JSON are language-neutral; Rust gets its own thin loader. The highest-value artifact in the repo is unaffected. |
| `packages/contracts` — ~1,200 lines of types, schemas, taxonomy, seams | **Ported.** The design carries over whole — the four error kinds, the capability model with no implicit hierarchy, the eight seams, `unknown` as a first-class state. The syntax gets rewritten in Rust, and TypeScript is regenerated from it. |
| `packages/adapter-mock` — deterministic server, 8 faults, 44 tests | **Ported.** `sync` is Rust and must test against it. The TypeScript version becomes the specification for the port: the fault taxonomy, the state-counter model, seeded determinism and the `apply-then-fail` semantics all transfer directly. |
| The three provider-seam bugs the mock found | **Carry over.** They are fixed in the design, not just in the TypeScript. |

Roughly two of the three built packages get rewritten. That is a real cost and it
is cheapest now, at ~4,000 lines, than at any later point.

## Week 0 — contracts and fixtures

| Deliverable | State |
|---|---|
| Golden corpus + loader (`packages/fixtures`) | 🟡 22 of a target 300+ messages. Unaffected by the language change |
| Contracts — design | ✅ Settled and reviewed |
| Contracts — Rust implementation (`daak-contracts`) | ⬜ Not started. Next lane |
| TypeScript binding generation (D-15) | ⬜ Not started. Generator not yet chosen |
| `ARCHITECTURE.md` — the invariants | ✅ Done, updated for the language boundary |
| CI from commit one | 🟡 TypeScript side green; Rust side not yet wired; performance budgets land in week 3 |
| Tech stack decided | ✅ D-01 to D-16 settled with the owner, except the licence |

### What is genuinely finished

The corpus and its integrity checks. The stack decisions, each with a revisit
trigger, now reviewed rather than assumed. The contract *design*, proven against
a real implementation.

### What is only started

**The corpus.** 22 messages against a target of 300+. Every category the plan
names is represented, so the shape is right, but coverage inside each is thin —
`malformed` especially, which is where parsers actually fail.

**The Rust core.** Nothing exists yet beyond the workspace scaffold.

**CI performance budgets.** The numbers are in `ARCHITECTURE.md`. Nothing
measures them, because nothing exists to measure.

## Week 1 — pure lanes

| Lane | Crate | State |
|---|---|---|
| — | `daak-contracts` | ⬜ **Start here.** Everything else compiles against it |
| A | `daak-mime` | ⬜ Wraps `mail-parser`; validate against the corpus |
| B | `daak-threading` | ⬜ Not started |
| C | `daak-store` | ⬜ Not started |
| D | `daak-adapter-mock` | 🟡 Design and tests exist in TypeScript; port to Rust |

## Weeks 2–4

Not started. `sync` is the deep-review lane and depends on `store` plus
`adapter-mock`; the mock's `apply-then-fail` fault is what its convergence
proptest will be written against.

## Open decisions

| Decision | Blocking | Owner |
|---|---|---|
| Licence (Apache-2.0 for contracts + AGPL-3.0 for the rest, vs uniform permissive) | Nothing yet; blocks going public | Owner |
| Binding generator: `ts-rs` vs `specta` (D-15) | The contracts lane | Try both against `IntentOp` and `EventPayload` |
| Plugins: JavaScript in the client vs WASM in the core (D-16) | Week 4 | Starting with JS; revisit if capability enforcement gets awkward |

## Known gaps worth naming

- No adapter has ever spoken to a real server. `adapter-mock` implements the
  contract faithfully, which is not the same as a real server implementing it
  faithfully. `apps/dev-stalwart`'s compose file is written but unvalidated.
- The eight seams have one implementation each at most. The plan calls for two
  by day 30, which is what proves an abstraction rather than assuming it.
- Nothing has been profiled. Every performance claim in this repo is currently a
  budget, not a measurement.
