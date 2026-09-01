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
| Licence | Apache-2.0 (`contracts`) · AGPL-3.0-or-later (everything else) |
| Language | TypeScript 5.9, strict, ES2023 |
| Runtime | Node 22 LTS; browser for the client |
| Monorepo | pnpm workspaces |
| Build | None for libraries — TS source resolution. Vite for the app |
| Tests | Vitest + fast-check |
| Lint/format | Biome |
| Validation | Zod 4 |
| Storage | SQLite — `node:sqlite` (Node), `sqlite-wasm` + OPFS (browser) |
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

### A Rust core was considered properly, and rejected

Recorded so it does not get relitigated from scratch.

A Rust engine (store, sync, MIME, threading, search, adapters) with a TypeScript
client is genuinely attractive: reconciliation is the code most likely to be
*plausibly* wrong and Rust's type system is good at making illegal states
unrepresentable; `mail-parser` is battle-tested inside a real mail server; the
500k search budgets stop being a tuning exercise; and Tauri packaging falls out
rather than being retrofitted.

Three things sank it:

1. **It splits the contract across two languages** — the exact seam the build
   plan warns must not drift while several lanes run in parallel. Containable by
   generating the TypeScript from Rust and failing CI on a diff, but that is a
   generation step, a generator choice, and a new failure mode, all before any
   product code exists.
2. **It forces a daemon.** Rust in the browser means compiling to WASM with an
   OPFS SQLite VFS, which is a research project. The realistic shape is `daakd`,
   a local process the client talks to over RPC — which means Daak stops being a
   URL you open with nothing installed.
3. **It doubles the surface at the worst moment.** Two toolchains, two test
   frameworks, two lint setups, and two idioms for agents to hold, during the
   weeks when review bandwidth is already the stated bottleneck.

None of these are objections to Rust. They are objections to paying for it
before there is anything to make fast. The store's driver abstraction keeps the
door open: when profiling says the engine is the problem, a Rust core behind
`MailProvider` and the store interface is a contained change rather than a
rewrite.

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

**Chosen:** SQLite with FTS5, behind one driver interface in `@daak/store`.
**`node:sqlite` on Node**, `@sqlite.org/sqlite-wasm` over OPFS in the browser.
Hand-written SQL and numbered migrations keyed on `pragma user_version`.

**Why `node:sqlite` rather than `better-sqlite3`,** which this decision
originally named: it is built into Node 22, which is already the floor (D-14),
so it costs no dependency and — more importantly — no native build step.
Contributors run `pnpm install` and it works; CI needs no toolchain. Tested
before adopting: SQLite 3.51.2 with FTS5, recursive CTEs and JSON1, which is the
entire feature list the store needs. It is synchronous, which fits "single
writer per account" exactly.

The caveat, stated honestly: `node:sqlite` is still marked experimental in Node
22 (stable in 24), and prints a warning on every run. The surface used is small,
and `better-sqlite3` remains a drop-in behind the same driver interface — which
is what the interface is for.

**Why:** the same schema and the same queries run on the server and in the
browser, so `store` is written once. FTS5 is in both builds, so search does not
need a second engine.

No ORM because the queries that matter here — recursive CTEs for threads, FTS5
with custom ranking, partial indexes for the unread counts — are exactly the
ones an ORM makes harder to write and harder to read. The schema is small and
the queries are the product.

**Over:** Drizzle (good types, wrong layer for this); IndexedDB directly (no
FTS, worse ergonomics); a server-only store (kills offline, which is the point);
`better-sqlite3` (mature and widely used, but a native build for no feature we
need).

**The one real unknown, and how it gets closed:** whether OPFS SQLite holds up at
500k messages across Chrome, Safari and Firefox. Nothing else in this stack is
unproven at the scale we need. Spike it in week 1 alongside the `store` lane —
load a seeded 500k corpus, measure query latency and index build time in each
browser — rather than discovering it in week 3 when the UI is already built on
the assumption.

**Revisit if:** that spike comes back badly. The fallback is a Node engine with
the browser as a thin client over RPC, which the driver interface already
permits and which costs the zero-install web story but nothing else.

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

**Chosen:** `postal-mime` for parsing, wrapped behind `@daak/mime`'s own types.
Build (`mimetext` or similar) is deferred to the compose lane in week 4, where
there will be something to build.

**The evaluation, since this decision demanded one.** All 22 fixtures were run
through `postal-mime` raw and compared against their expectations. 15 passed
untouched. It got right every part that is genuinely hard: Shift_JIS and
ISO-8859-1 bodies, RFC 2047 encoded words in three charsets and scripts, an
unclosed boundary, 400+ headers with a 60-address folded header, `message/rfc822`
nesting, quoted-printable and base64. It also preserves RFC 5322 groups rather
than flattening them lossily, which was the one thing that would have disqualified
it.

The seven divergences were all policy, which is exactly what a wrapper is for:
what counts as an attachment (inline `cid:` images, detached signatures and
calendar bodies are not), `List-Id` extraction from inside the angle brackets,
angle-bracket stripping on message ids, group flattening, and refusing to return
an unparseable `Date` as if it were a date.

The one thing it does not provide is the part tree, which the corpus asserts on.
`src/structure.ts` scans for it — Content-Type headers and boundary delimiters
only, no decoding and no charset work, which keeps it small enough to be
obviously right.

**Why:** it is the highest-leverage place to not write code. Nobody writes a
correct MIME parser first time, and the failure mode is silent — a mislabeled
charset renders as mojibake, not as an error. The corpus is what makes wrapping
safe: if a library fails a fixture, we find out before users do.

The wrapper is the deliverable. It is what lets the library be replaced later
without touching anything else.

**Revisit if:** `postal-mime` fails a corpus fixture the wrapper cannot correct,
in which case wrap a different library — not write our own. The wrapper is what
makes that a contained change: 91 tests pin the behaviour, and the corpus proves
any replacement.

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

## D-17 — Split licence: Apache-2.0 for the interfaces, AGPL-3.0 for the rest

**Chosen:** `packages/contracts` is Apache-2.0. Everything else is
AGPL-3.0-or-later. See `LICENSING.md`.

**Why:** the two halves want opposite things. The interfaces should be
implementable by anyone — a provider, a plugin, an integration, an agent —
without a legal conversation first, because an interface nobody can implement
freely is not an open interface. The application should not be closeable by the
first well-funded hosted fork, because "your mailbox should not depend on a
company's permission to exist" is hollow if that is exactly what happens.

**Over:** uniform Apache-2.0 (friendliest to adoption and corporate
contributors; no protection at all against a closed hosted fork); uniform AGPL
(one rule, simpler to explain, but it puts friction in front of exactly the
plugin and integration authors the extension model depends on).

**The known cost:** some organisations ban AGPL dependencies outright. Those
teams can still build against `@daak/contracts`, which is Apache-2.0 and is what
they would be importing anyway — only the application itself is AGPL. That is
the split doing its job.

**Revisit if:** the AGPL turns out to be blocking contributions rather than
hosted forks — the tell is contributors saying their employer will not let them
near the repository, not users saying they prefer MIT.

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
