# Tech stack

Decisions, with the reasoning attached. Each one records what was chosen, what
it was chosen over, and what would make us revisit it. A decision without a
revisit trigger is a superstition.

Status: **settled for v0.1** unless marked otherwise. Changing one is a
conversation, not a commit — but they are all revisitable, and several are
expected to be revisited.

---

## Summary

| Layer | Choice |
|---|---|
| Core language | Rust 2024, for the engine, store, sync, MIME and adapters |
| Client language | TypeScript 5.9, strict, for UI and plugins |
| Contracts | Defined in Rust, TypeScript generated. Drift is a CI failure |
| Client ↔ core | `daakd`, a local daemon. JSON-RPC over WebSocket |
| Runtime | Rust 1.94+ for the core; Node 22 LTS for tooling and the client |
| Monorepo | cargo workspace + pnpm workspace, side by side |
| Build | `cargo build` for the core. No build step for TS libraries; Vite for the app |
| Tests | `cargo test` + proptest (core); Vitest + fast-check (client) |
| Lint/format | clippy + rustfmt (core); Biome (client) |
| Validation | Rust types at the core boundary; Zod for plugin and agent input |
| Storage | SQLite via `rusqlite`, one native implementation in the core |
| Search | SQLite FTS5 |
| Protocol | JMAP (RFC 8620/8621), hand-rolled client |
| Dev server | Stalwart via Docker Compose |
| MIME | Wrap a maintained library; validate against the corpus |
| UI | React 19 + Vite, headless view models in `ui-core` |
| UI components | Radix primitives via shadcn/ui, re-themed |
| Styling | Tailwind v4, themed from `brand/tokens.css` |
| Drafts | Yjs CRDT (week 4) |
| AI | Provider interface; Anthropic + Ollama adapters, both optional |
| Agents | MCP server over the command registry |
| CI | GitHub Actions |

---

## D-01 — Rust core, TypeScript client

**Chosen:** the engine is Rust — store, sync, MIME, threading, search, the
provider adapters and the command registry. The client is TypeScript — the React
shell, view models, keymap and the plugin host. They meet at `daakd`, a local
daemon (D-16), over contracts defined in Rust and generated into TypeScript
(D-15).

**Why:** the parts of Daak where correctness and speed actually matter are the
parts Rust is good at. Reconciliation is the code most likely to be *plausibly*
wrong, and a type system that makes illegal states unrepresentable is worth real
money there. MIME parsing over a hostile corpus wants memory safety and
`mail-parser`, which is battle-tested inside an actual mail server. The 500k-row
search and index budgets stop being a tuning exercise. And a native core makes
Tauri packaging and a single-binary self-host story fall out rather than being
retrofitted.

**Over:** TypeScript everywhere, which was the original decision here. That
bought one literally-shared contracts package across browser, engine and
plugins — no generation step, no drift, one language for every lane.

**The cost, stated plainly:** this splits the contract across two languages,
which is the exact seam the build plan warns must not drift while several lanes
run in parallel. It is a real risk and it is accepted deliberately.

**How the cost is contained:** D-15. Contracts are defined once in Rust and the
TypeScript is generated and committed; CI regenerates and fails on any diff.
Drift becomes a build failure rather than something review has to catch — which
is a stronger guarantee than the single-language version had, where nothing
mechanically stopped two packages describing the same shape differently.

**Revisit if:** the generation step turns out to be friction rather than a
guardrail — the tell would be lanes working around generated types instead of
changing the Rust definition.

---

## D-02 — cargo workspace + pnpm workspace, no build step for TS libraries

**Chosen:** a cargo workspace under `crates/` and a pnpm workspace under
`packages/`, side by side in one repository. Internal TS packages export
`./src/index.ts` directly
and resolve through tsconfig paths. Typecheck is one root `tsc --noEmit`. Only
`web` has a build, via Vite.

**Why:** there is nothing to keep in sync, nothing to rebuild before a test run,
and no stale `dist/` to debug. With one agent per package landing separate PRs,
"did you rebuild the dependency first" is a class of failure worth removing
entirely.

**Over:** project references with `tsc -b` (correct, and adds a build graph to
every workflow); Turborepo (real caching, but the CI is currently ~30 seconds).

**Revisit if:** we publish packages to npm — then they need real builds and
`.d.ts` output — or CI passes ~3 minutes, where Turborepo's caching starts to
pay for its configuration.

---

## D-03 — cargo test + proptest, Vitest + fast-check

**Chosen:** `cargo test` with `proptest` for the core; Vitest with `fast-check`
for the client.

The sync engine's convergence property — for any sequence of local mutations and
any injected fault pattern, local state converges to server state after
reconnect — is a proptest, written before the implementation. That test is the
whole reason property-based testing is non-negotiable here.

**Why:** Vitest transpiles TS with no configuration, which is what makes D-02
work. Property-based testing is not optional here — the build plan's central
test discipline is "for any sequence of local mutations and any injected fault
pattern, local state converges after reconnect", and that is a property, not an
example.

**Revisit if:** browser-environment tests outgrow jsdom, in which case Playwright
joins for `web` rather than replacing Vitest.

---

## D-04 — clippy + rustfmt for the core, Biome for the client

**Chosen:** Biome 2, one config, one command.

**Why:** one tool instead of two plus a plugin set, and fast enough that agents
run it without being asked. Fewer knobs matters more than a longer rule list
when the code is being written in parallel by many hands.

**Trade-off, stated plainly:** we lose type-aware lint rules. `tsc` in strict
mode covers most of what those rules catch, and the invariants that matter here
are architectural — they need review and tests, not a linter.

**Revisit if:** we start needing custom architectural lint rules (e.g. enforcing
the import table in ARCHITECTURE.md), which today are enforced by review.

---

## D-05 — Zod 4 at the client boundary

**Chosen:** Zod validates what enters the client from somewhere untrusted —
plugin manifests, plugin-registered command arguments, and anything an agent
sends. Persisted shapes and provider payloads are validated by Rust types in the
core, so Zod's role is narrower than it was under the all-TypeScript plan.

**Why:** command arguments must be validated before a handler runs — that is
precisely what makes a command safe to expose to an agent. Having one validation
library that also generates the TypeScript types keeps the schema and the type
from drifting.

**Over:** Valibot (smaller bundle, less ecosystem); TypeBox (JSON Schema native,
clumsier types). Bundle size matters for `web` and is worth measuring before
launch; correctness of the agent boundary matters more.

**Revisit if:** the client bundle becomes a launch-blocking problem — Valibot is
a near-drop-in for the subset we use.

---

## D-06 — SQLite via `rusqlite`, one native store, no ORM

**Chosen by me, at the owner's request.** SQLite with FTS5, through `rusqlite`
with the bundled feature so there is no system dependency. One implementation,
living in the Rust core. Hand-written SQL and numbered migrations keyed on
`user_version`. No browser-side store.

**Why this changed:** the previous decision carried two drivers —
`better-sqlite3` on Node and `sqlite-wasm` over OPFS in the browser — because
the store was TypeScript and had to run in both places. Choosing a Rust core
(D-01) removes that constraint entirely, and with it the single largest unknown
in the whole stack: whether OPFS SQLite holds up at 500k messages across
browsers. That risk does not need mitigating now; it needs not existing.

One store implementation instead of two also means one schema, one set of
queries, one migration path, and one place where the "rebuildable from blobs +
events" invariant is enforced.

**Still no ORM,** for the same reason as before: the queries that matter here are
recursive CTEs for threads, FTS5 with custom ranking, and partial indexes for
unread counts — exactly what Diesel or SeaORM would put a layer over. The schema
is small and the queries are the product.

**`rusqlite` over `sqlx`:** sqlx offers compile-time-checked SQL, which is
genuinely attractive. But its SQLite support is async-first and less mature for
embedded use, and `rusqlite` being synchronous is a better fit for "single writer
per account", which is already a sync-engine invariant rather than a limitation.

**The consequence worth knowing:** offline-first now means the *daemon* holds
local state, not the browser. The web client needs `daakd` running. For a
self-hostable product aimed at developers that is the normal shape — and it is
what makes the single-binary story possible — but it does mean Daak is not a URL
you open with nothing installed. Say the word if that trade is wrong for you.

**Revisit if:** a pure-browser deployment becomes a requirement, at which point
the options are compiling the core to WASM with an OPFS VFS (hard, and a research
project) or a thin browser store for a cache-only subset.

---

## D-07 — JMAP first, hand-rolled client

**Chosen:** JMAP (RFC 8620 core, RFC 8621 mail) as the first real adapter, with
a thin hand-written client rather than a library.

**Why:** JMAP gives us a proper change-cursor model, batching, and push. Sync
against it is a correct design rather than a workaround, which matters because
the IMAP adapter arrives afterwards and should be the one making compromises.

Hand-rolled because the protocol is JSON over HTTP and the parts we care most
about — state strings, batch sizing, partial `SetError` handling — are exactly
the parts a client library would abstract away from us.

**Over:** IMAP first (larger addressable audience, much worse sync semantics to
build the engine's first assumptions on); `jmap-jam` (young, and this is the
layer we most want to control).

**Revisit:** not the choice, but the sequencing — IMAP is days 30–60 and is what
reaches users who do not self-host.

---

## D-08 — Stalwart for development, via Docker Compose

**Chosen:** Stalwart as the dev mail server, seeded at 1k / 50k / 500k messages.

**Why:** JMAP-native, self-hostable, one container. It is also the server most
likely to be on the other end for early self-hosting users, so the numbers we
tune against are the numbers they will see.

---

## D-09 — Wrap a MIME library, do not write one

**Chosen:** wrap a maintained parser behind `@daak/mime`'s own types and validate
the wrapper against the corpus. Candidates: `postal-mime` (parse — runs in the
browser, actively maintained) and `mimetext` (build). Both to be evaluated
against the corpus before either is adopted; record the result here.

**Why:** it is the highest-leverage place to not write code. Nobody writes a
correct MIME parser first time, and the failure mode is silent — a mislabeled
charset renders as mojibake, not as an error. The corpus is what makes wrapping
safe: if a library fails a fixture, we find out before users do.

The wrapper is the deliverable. It is what lets the library be replaced later
without touching anything else.

**Revisit if:** a candidate fails corpus fixtures it cannot be patched around,
in which case wrap a different one — not write our own.

---

## D-10 — React for the shell, headless view models underneath

**Chosen:** React 19 + Vite for `web`. All state, list virtualisation logic and
the command registry live in `@daak/ui-core`, which does not know React exists;
components bind via `useSyncExternalStore`.

**Why:** the split is what keeps the UI testable without a DOM, keeps a second
frontend (mobile, terminal) possible, and keeps components honest — a component
that renders and dispatches command ids cannot accumulate business logic.

React specifically for ecosystem depth on the hard parts (virtualised lists,
rich text composition) and because contributors already know it.

**Over:** Svelte/Solid (leaner, smaller pool of contributors); a native shell
(much later, if at all).

**Revisit if:** React's overhead shows up in the 50ms interaction budget —
`ui-core` means swapping the renderer is a contained change.

---

## D-11 — Radix primitives via shadcn/ui, re-themed to Daak tokens

**Chosen:** Radix primitives for behaviour, shadcn/ui as the starting component
vocabulary (copied source, not a dependency), Tailwind v4 for styling, and
`brand/tokens.css` as the single source of truth that Tailwind's theme reads
from.

**Why:** Radix gives focus trapping, roving tabindex, portals and ARIA — real
work that is easy to get subtly wrong and expensive to retrofit. shadcn copies
source into the repo rather than adding a dependency, so there is no version
lock and unused components are deleted rather than carried. Its `Command`
component (built on `cmdk`) is a substantial head start on the palette, which is
central to this product.

The strongest argument is the build model: many agents writing UI in parallel
produce far more consistent work against a known component vocabulary than they
do inventing a dialog per pull request.

**Over:** Radix alone with a hand-written styled layer (more control over the
look, more work per component, less leverage for parallel agents); Base UI (same
model, newer, far fewer worked examples for an agent to follow); hand-rolling
everything (writing our own focus traps is the classic source of subtle
accessibility bugs).

**This reverses the earlier decision** to use plain CSS custom properties over
Tailwind. Tailwind v4 is CSS-first and variable-based, so `brand/tokens.css`
remains the source of truth and plugin/user theming still has a supported
surface — which was the whole reason for the original choice.

### Two conditions this decision is contingent on

**1. Re-theme before the first component lands.** The shadcn default look is the
most recognisable aesthetic on the web right now, and BRAND §17 asks for quiet,
minimal and distinctive. Used as shipped it works directly against the brand.
Replacing the theme with Daak tokens is a first-commit task in the `web` lane,
not a later cleanup.

**2. Settle keyboard ownership before the first Radix component lands.** Radix
components own their own key handling and trap focus; Daak dispatches a global
keymap into the command registry. Who owns `Escape` while a popover is open over
the message list needs an explicit rule in `ui-core`, decided up front rather
than discovered in week 3. This is the one real integration risk in the choice.

**Revisit if:** Tailwind's class surface starts eroding the brand discipline
that D-11 originally existed to protect — the tell is hard-coded colour values
appearing in components instead of token references.

**Note:** the hardest parts of this UI get nothing from either library. The
virtualised 500k-row list, the thread view and the composer are TanStack Virtual
plus custom code either way. shadcn covers the surrounding ~20% — dialogs,
menus, palette, toasts, settings forms.

---

## D-12 — AI is a layer, never a dependency

**Chosen:** `LLMProvider` in contracts, adapters for Anthropic and Ollama, keys
in the OS keychain, `residency` declared per provider, annotators declaring what
they read.

**Why:** brand principle 05, made structural rather than aspirational. Daak must
work fully with no model configured, and removing `@daak/intelligence` must not
break reading, searching, or sending mail. If it does, the dependency is
backwards.

---

## D-13 — MCP as the agent surface, built early

**Chosen:** an MCP server over the command registry and the read API, built as
soon as the registry exists — even with zero integrations.

**Why:** it costs little once commands exist, and it makes the mailbox
addressable by any agent, including the ones building this product. It is also
the honest test of whether the command abstraction is real: if commands cannot
be driven from outside the UI, they are not commands.

---

## D-14 — Toolchain floors

**Chosen:** Rust 1.94 (2024 edition) for the core. Node ≥ 22.12 for the client
and for tooling.

**Why:** Rust 1.94 is what the workspace is developed against and the MSRV is
pinned in `rust-toolchain.toml` so every agent and CI run compiles identically.
Node 22 is LTS through 2027, has native TypeScript type-stripping so repo tools
run without a loader, and stable `fetch`.

---

## D-15 — Contracts defined in Rust, TypeScript generated

**Chosen:** every persisted shape, error kind, capability and RPC message is
defined once in the `daak-contracts` crate. TypeScript types are generated from
it and **committed to the repo**. CI regenerates and fails if the result differs
from what is checked in.

**Why:** this is the entire mitigation for the risk D-01 accepts. Two
hand-maintained definitions of the same shape drift — always, and silently, and
usually at the moment a third lane starts depending on both. A generated
definition with a CI diff check cannot: changing the Rust type without
regenerating is a red build, and changing the TypeScript by hand is a red build.

Committing the generated output (rather than generating at build time) means the
TypeScript side needs no Rust toolchain to develop against, and that a reviewer
sees the shape change in the diff rather than having to imagine it.

**Over:** a neutral IDL (protobuf, JSON Schema) generating both sides — one more
language to learn and a worse fit for Rust's enums, which are what make the
intent and event taxonomies precise. Hand-maintained parallel definitions — the
failure mode this decision exists to prevent.

**Open:** the generator itself. `ts-rs` and `specta` are the candidates; pick by
trying both against the existing `IntentOp` and `EventPayload` unions, which are
the shapes most likely to generate badly.

---

## D-16 — `daakd`: the client talks to the core over a local daemon

**Chosen:** the Rust core runs as `daakd`, a local process. The web client talks
to it over JSON-RPC on a WebSocket. In the desktop build, Tauri hosts the same
core in-process and the same RPC surface travels over IPC instead.

**Why:** it gives one deployment shape that covers every case — run it on your
laptop, run it on your server, embed it in the desktop app — without the client
needing to know which. The daemon is also the natural home for anything that
must work with no UI open: rules firing on new mail, annotators running, and the
MCP server exposing commands to agents. An agent should not need a browser tab
to archive a message.

**The command registry lives in the core** for exactly that reason. `ui-core`
keeps the keymap, palette and view-model concerns and invokes commands over RPC.
That keeps "one action layer, six front doors" true for agents and rules, not
just for the UI.

**Open:** whether plugins stay JavaScript in the client (what extension authors
know, and where the UI contributions are) or become WASM in the core (better
sandboxing, one place for capability enforcement). Starting with JS in the
client, registering into the core over the same RPC.

---

## Open — licensing

**Not decided. Needs the owner's call.**

The recommendation is a split: **Apache-2.0 for `@daak/contracts`** so anyone can
implement a provider, plugin or integration against the interfaces without
licence friction, and **AGPL-3.0-or-later for everything else** so a hosted fork
must publish its changes.

That combination is what several self-hostable projects settled on, and it fits
the positioning: open protocols, open source, your infrastructure — without
handing a closed SaaS a free client.

The alternative is a uniform MIT/Apache-2.0 repo: friendlier to embedding and to
corporate contributors, no protection against a closed hosted fork.

No `LICENSE` file is committed until this is decided, because the wrong one is
much harder to walk back than a missing one.

---

## Deliberately deferred

| Question | When |
|---|---|
| Desktop shell (Tauri vs Electron) | After the web client works. Tauri leads — smaller, and a Rust core we may want anyway |
| Mobile | Month 4+ |
| IMAP adapter | Days 30–60 |
| Package publishing to npm | When the interfaces have stopped moving |
| Telemetry | Only if it can be local-only and off by default |
| Hosted sync service | Not planned. Daak must not need one |
