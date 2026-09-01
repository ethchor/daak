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
| Language | TypeScript 5.9, strict, ES2023 |
| Runtime | Node 22 LTS; browser for the client |
| Monorepo | pnpm workspaces |
| Build | None for libraries — TS source resolution. Vite for the app |
| Tests | Vitest + fast-check |
| Lint/format | Biome |
| Validation | Zod 4 |
| Storage | SQLite — `better-sqlite3` (Node), `sqlite-wasm` + OPFS (browser) |
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

## D-01 — TypeScript everywhere

**Chosen:** TypeScript 5.9, `strict` plus `noUncheckedIndexedAccess` and
`exactOptionalPropertyTypes`.

**Why:** one language across the browser client, the Node engine, the sync
engine and the plugin API means one set of contracts, literally shared rather
than mirrored. `@daak/contracts` being importable by every layer is the whole
architecture; that is worth more than any per-layer language advantage.

The extra-strict flags are on from commit one because they cost nothing now and
are close to unadoptable at 25k lines.

**Over:** Rust for the engine with a TS client. Faster and more robust, and it
splits the contracts in two — which is exactly the seam the plan says must not
drift while several agents work in parallel.

**Revisit if:** the sync engine or search becomes CPU-bound in a way profiling
cannot fix, at which point a Rust core behind the same interfaces is a
contained change (and `store` is already driver-abstracted for it).

---

## D-02 — pnpm workspaces, no build step for libraries

**Chosen:** pnpm workspaces. Internal packages export `./src/index.ts` directly
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

## D-03 — Vitest and fast-check

**Chosen:** Vitest for everything; fast-check for property tests.

**Why:** Vitest transpiles TS with no configuration, which is what makes D-02
work. Property-based testing is not optional here — the build plan's central
test discipline is "for any sequence of local mutations and any injected fault
pattern, local state converges after reconnect", and that is a property, not an
example.

**Revisit if:** browser-environment tests outgrow jsdom, in which case Playwright
joins for `web` rather than replacing Vitest.

---

## D-04 — Biome over ESLint + Prettier

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

## D-05 — Zod 4 for every persisted and crossing-a-boundary shape

**Chosen:** Zod for the store schema shapes, provider payloads, command
arguments, plugin manifests and annotator output.

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

## D-06 — SQLite, two drivers, no ORM

**Chosen:** SQLite with FTS5. `better-sqlite3` on Node, `@sqlite.org/sqlite-wasm`
over OPFS in the browser, behind one driver interface in `@daak/store`.
Hand-written SQL and numbered migrations.

**Why:** the same schema and the same queries run on the server and in the
browser, so `store` is written once. FTS5 is in both builds, so search does not
need a second engine.

No ORM because the queries that matter here — recursive CTEs for threads, FTS5
with custom ranking, partial indexes for the unread counts — are exactly the
ones an ORM makes harder to write and harder to read. The schema is small and
the queries are the product.

**Over:** Drizzle (good types, wrong layer for this); IndexedDB directly (no
FTS, worse ergonomics); a server-only store (kills offline, which is the point).

**Revisit if:** OPFS SQLite proves unreliable across browsers at 500k messages —
the fallback is a Node engine with the browser as a thin client, which the
driver interface already permits.

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

## D-14 — Node 22 LTS as the runtime floor

**Chosen:** Node ≥ 22.12.

**Why:** native TypeScript type-stripping (so tools in `tools/` run without a
loader), stable `fetch`, and modern `AbortSignal` behaviour. 22 is LTS through
2027.

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
