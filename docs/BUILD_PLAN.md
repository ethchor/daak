# Build plan — agent-parallel, 30 days

The working roadmap for Daak: **open + self-hostable, JMAP-native, Stalwart
backend, built with multiple coding agents over ~1 month.**

Status is tracked in `docs/STATUS.md`. This document is the plan; that one is
where we are against it.

---

## 0. What agents change, and what they don't

**Compresses dramatically:** boilerplate, schema and migration code, adapter
implementations against a documented protocol, test scaffolding, UI components,
parsers with a spec to work from, documentation.

**Does not compress:**

- **Review bandwidth.** Ten agents produce more code than one person can read
  carefully. Review is the bottleneck, and this plan is organised around
  reducing what needs deep review rather than increasing what gets written.
- **Sync correctness.** Reconciliation bugs are the ones agents get *plausibly*
  wrong — code that looks right, passes the obvious tests, and corrupts state on
  the third reconnect. These surface over weeks against real mailboxes, not in a
  sprint.
- **Real-world MIME.** No agent can anticipate the 2004 Outlook message with a
  broken boundary and a mislabeled charset. Only a corpus can.
- **Perceptual performance.** Sub-50ms is tuned by feel against real data
  volumes.

The plan therefore front-loads **contracts, fixtures, and a chaos harness** —
the three things that let you trust code you didn't read line by line.

---

## 1. The unifying insight

The architecture that survives decades and the architecture agents can build in
parallel are **the same architecture**.

Both demand: hard module boundaries, explicit interfaces, no shared mutable
state, and every module testable in isolation without network or credentials.
"Future-proof" and "parallelizable" are the same property viewed from different
time horizons.

So the rule for the whole month is: **contracts first, then everything at once.**

---

## 2. Repo structure — one package per agent lane

```text
daak/
├── ARCHITECTURE.md          ← the constitution; agents read this first
├── BRAND.md                 ← voice, vocabulary, visual direction
├── docs/                    ← BUILD_PLAN, TECH_STACK, STATUS
├── brand/                   ← tokens.css, daak-mark.svg
├── crates/                  ← the Rust core
│   ├── daak-contracts/      ← types, taxonomy, traits. SOURCE OF TRUTH. Locked after week 0
│   ├── daak-mime/           ← RFC 5322/2045, byte-preserving
│   ├── daak-threading/      ← JWZ threading, deterministic
│   ├── daak-store/          ← SQLite schema, migrations, queries
│   ├── daak-provider/       ← the MailProvider trait
│   ├── daak-adapter-mock/   ← deterministic fake server + chaos injection
│   ├── daak-adapter-jmap/   ← JMAP provider
│   ├── daak-sync/           ← engine: cursor, intent log, reconciliation
│   ├── daak-search/         ← FTS5, query grammar
│   ├── daak-commands/       ← the command registry
│   ├── daak-intelligence/   ← LLM traits, annotators, BYOK
│   ├── daak-server/         ← daakd: RPC, rules runner, MCP
│   └── daak-bindings/       ← generates the TypeScript contract
├── packages/                ← the TypeScript client
│   ├── contracts/           ← generated types + typed RPC client
│   ├── fixtures/            ← golden corpus, shared by both languages
│   ├── ui-core/             ← keymap, palette, view models
│   ├── plugin-host/         ← extension loading, capability sandbox
│   └── web/                 ← React + Radix shell
└── apps/
    ├── dev-stalwart/        ← docker-compose Stalwart + seeded mailboxes
    └── desktop/             ← Tauri shell (later)
```

Each crate and package has: its own `CLAUDE.md` stating scope and forbidden
dependencies, its own test suite, and a public API surface defined in
`daak-contracts`. One agent owns one crate or package per session. No agent edits
`daak-contracts` after week 0 without the owner in the loop — that, plus the
generated-bindings CI check, is what prevents drift.

---

## 3. Week 0 — Contracts and fixtures (3–4 days, heavy review)

This is the only phase where every line gets read. Everything downstream
inherits its correctness from here.

**Deliverables:**

1. **`contracts/`** — the `MailProvider`, `LLMProvider`, `BlobStore`,
   `Annotator`, `Command`, and `Plugin` interfaces. Zod schemas for every
   persisted shape. A single error taxonomy (transient / permanent / auth /
   conflict) that every layer speaks.

2. **`fixtures/`** — a golden corpus. Aim for 300+ real messages covering:
   nested multipart, inline images, calendar invites, S/MIME, non-UTF8 charsets,
   RFC 2047 encoded words, broken boundaries, 8-bit bodies, absurd header
   counts, 50MB attachments, and threads with missing `References`. Pull from
   public mailing-list archives. Each fixture pairs with an expected parse
   output. **This corpus is the regression suite for the next decade** — it's
   the highest-value artifact of the whole month.

3. **`ARCHITECTURE.md`** — the invariants, written as rules agents must not
   break:
   - Message blobs are immutable and content-addressed. Nothing rewrites them.
   - Every table other than `blobs` and `events` must be rebuildable from those
     two.
   - No provider-specific concept crosses the adapter boundary.
   - All local mutations go through the intent log. No direct state writes.
   - Annotations are versioned and disposable.

4. **CI from commit one** — typecheck, tests, and a performance budget that
   fails the build. Agents optimise for green CI, so encode what you care about
   in CI.

**Why this pays:** an agent given a locked interface, a schema, and 40 fixtures
with expected outputs produces reviewable, verifiable work. The same agent given
"implement MIME parsing" produces something you must read entirely.

---

## 4. Week 1 — Pure lanes, maximum parallelism

Four agents, fully independent, none needing network or credentials.

| Lane | Package | Why it's first | Done when |
|---|---|---|---|
| A | `mime` | Pure function, fully specified by RFCs, fully testable by fixtures. Highest agent leverage in the project. | Full corpus parses; round-trip preserves bytes exactly |
| B | `threading` | Pure, deterministic, algorithm is published (JWZ) | Threads match expected output on all fixture threads, including broken-header cases |
| C | `store` | Schema + migrations + typed queries. Mechanical given contracts. | Migrations run forward and back; property tests on flag/label set operations |
| D | `adapter-mock` + chaos harness | **The single most important week-1 deliverable** | Can replay a scripted session with injected disconnects, reordered responses, duplicated events, and stale cursors |

**On lane D:** the mock adapter is what makes weeks 2–4 possible. It is a
deterministic in-memory server implementing `MailProvider`, plus a fault
injector. Every subsequent agent tests against it — no credentials, no
flakiness, no rate limits, reproducible failures. Give it your second-best
attention after the sync engine.

For MIME and threading specifically, wrap a mature library rather than
generating from scratch, and use the corpus to validate the wrapper. Agents
write plausible MIME parsers; nobody writes correct ones on the first attempt.

---

## 5. Week 2 — The engine

| Lane | Package | Notes |
|---|---|---|
| A | `sync` | **The deep-review lane.** Do not delegate the reconciliation logic without reading it fully. |
| B | `adapter-jmap` | Well-specified by RFC 8620/8621 — good agent work. Validate against real Stalwart. |
| C | `search` | FTS5 indexing + query grammar (`from:`, `has:`, date ranges). No AI yet. |
| D | `dev-stalwart` + import tooling | Seeded mailboxes at 1k / 50k / 500k messages for perf testing |

**Sync engine specifics worth stating to whichever agent builds it:**

- Single writer per account. No concurrent mutation of account state.
- Two independent lanes: live tail and historical backfill. Backfill never
  blocks live.
- Local mutations are appended to an intent log, applied optimistically, then
  pushed. On rejection, replay and reconcile — never treat local+remote as one
  transaction.
- Flags are last-write-wins per flag. Labels are observed-remove sets. Bodies
  are immutable.
- Every mutation is idempotent and carries a client-generated id, so a retry
  after an ambiguous failure is safe.

**Non-negotiable test discipline for this package:** property-based tests
(fast-check) asserting that for any sequence of local mutations and any injected
fault pattern, local state converges to server state after reconnect. This is
the test that catches the class of bug agents produce. Write the property before
the implementation.

---

## 6. Week 3 — The client

| Lane | Package | Notes |
|---|---|---|
| A | `ui-core` | Headless. View models, virtualized list state, and the **command registry** |
| B | `web` | React shell over `ui-core`. Dark, fast, keyboard-first. |
| C | search + store wiring | SQLite via OPFS in the browser; the same store package as server |
| D | perf harness | Interaction latency measured in CI against the 500k mailbox |

**The command registry is the architectural centrepiece of the UI.** Every
action — archive, snooze, reply, label, navigate — is a registered command with
an id, a handler, and metadata. Keybindings map to command ids. The command
palette lists them. User automation rules invoke them. Plugins register new
ones. AI agents call them.

That one abstraction gives you the keyboard-first feel, the palette, the rules
engine, the plugin surface, and the agent API for free, and it means adding a
feature is registering a command rather than touching the UI tree. It is the
highest-leverage decision in the client.

By end of week 3 there should be a working read path: open the app, see real
mail from the Stalwart instance, navigate entirely by keyboard, search locally,
work offline.

---

## 7. Week 4 — Write path and extensibility

| Lane | Package | Notes |
|---|---|---|
| A | compose + send | Draft CRDT (Yjs) for multi-device, MIME building, attachment blobs, JMAP submission |
| B | `intelligence` | Interface + BYOK key handling + two annotators (triage, summarise). Ollama for a local tier. |
| C | `plugin-host` | Loading, manifest, capability sandbox |
| D | hardening | Fixture corpus regression, chaos runs, memory profiling |

**Realistic day-30 state:** a JMAP-native client running against a self-hosted
Stalwart with read, compose, send, offline mutation, local search, keyboard
control, a working AI annotation layer with BYOK, and defined extension points.
Roughly 25–35k lines with real test coverage.

**What it is not:** shipped. No mobile, no IMAP, no import tooling, no
multi-account polish, and the sync engine will not have met a hostile real-world
mailbox yet. Call it a solid v0.1 that a public repo can be built around — which
is exactly what the open self-hostable path needs.

---

## 8. Plug-and-play: the eight extension points

These are the seams. Each one is an interface in `contracts/`, each has at least
two implementations by day 30 so the abstraction is proven rather than
theoretical.

| # | Seam | Interface | Ships with | Enables later |
|---|---|---|---|---|
| 1 | **Provider** | `MailProvider` | mock, JMAP | IMAP, Gmail, Graph, anything in 2040 |
| 2 | **Model** | `LLMProvider` | Anthropic, Ollama | any API, on-device, BYOK |
| 3 | **Annotator** | `Annotator` | triage, summarise | any message→metadata function, versioned and re-runnable |
| 4 | **Command** | `Command` | ~40 core commands | plugins, rules, AI agent actions, all through one bus |
| 5 | **Blob store** | `BlobStore` | filesystem, S3 | anything content-addressable |
| 6 | **View** | `ViewRenderer` | list, thread | split inbox, board, calendar-style, per-user layouts |
| 7 | **Rule** | `Rule` (condition → commands) | basic filters | full automation, NL-authored rules |
| 8 | **Integration** | read-only API + annotation write | none | calendar, tasks, CRM, and an MCP server exposing 1/3/4 to any agent |

**The rule that keeps these honest:** an extension may read core state through
the public API and write only to `annotations`. Nothing outside the core writes
to `messages`, `blobs`, or `events`. Any plugin must be deletable without a
migration.

Build seam 8 as an **MCP server** early even with zero integrations. It costs
little once the command registry exists, and it makes the mailbox addressable by
any agent — including the ones building the product.

---

## 9. How to actually run the agents

- **One agent, one package, one PR.** Cross-package changes go to the owner.
- **Per-package `CLAUDE.md`**: scope, allowed imports, forbidden imports, test
  command, the invariants from `ARCHITECTURE.md` that apply.
- **Tests before implementation** on `sync`, `mime`, and `store`. Ask for the
  property/fixture tests first, review those, then let the implementation be
  generated against them. Reviewing a test suite is far cheaper than reviewing
  an implementation, and it inverts the trust problem.
- **Forbid interface changes.** If an agent wants to modify `contracts/`, that's
  a signal to stop and think, not a diff to approve.
- **Weekly integration day.** Don't let five lanes diverge for a month; merge
  and run the full chaos suite every Friday.
- **Watch for the specific failure mode:** agents write reconciliation code that
  handles the happy path and the obvious error, and silently mishandles the
  ambiguous one — the request that timed out but succeeded server-side. Grep
  every adapter and sync path for that case explicitly.

---

## 10. Sequencing after day 30

- **Days 30–60:** IMAP adapter. This is what gets users who don't already
  self-host, and it's the fix for the feedback-loop risk of a JMAP-only
  audience.
- **Days 60–90:** import tooling (mbox, IMAP migration), multi-account,
  packaging — Docker compose that stands up Stalwart plus the client in one
  command. Self-hosting only spreads if it's one command.
- **Month 4+:** mobile, richer AI, plugin ecosystem, MCP integrations.

Open-source it at day 30 or shortly after, not at day 90. A working v0.1 with a
clean architecture attracts contributors; a polished v1 attracts users you can't
yet support.
