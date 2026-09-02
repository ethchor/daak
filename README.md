<div align="center">
  <img src="brand/daak-mark.svg" width="56" height="56" alt="Daak">
  <h1>Daak</h1>
  <p><strong>Mail, on your terms.</strong></p>
  <p>An open, local-first, programmable email client built for humans and agents.</p>
</div>

---

Daak rethinks email as a programmable system rather than a collection of
messages in a remote inbox.

Your mailbox holds conversations, people, files, decisions and actions. Daak
brings them together in a local-first architecture built on open protocols,
deterministic sync, commands, automation, extensibility and user-controlled
intelligence.

- **Own** — local-first storage, offline by design, self-hostable, no dependency
  on a central Daak service.
- **Connect** — JMAP-native, provider-independent, IMAP to follow.
- **Command** — every meaningful action is a command, invokable by keyboard, the
  palette, a rule, a plugin, or an agent.
- **Understand** — local search, threading, annotations, triage, summaries.
- **Extend** — plugins, rules, MCP, agent interfaces.

> **Status: week 2 in progress.** Parsing, threading, storage, a chaos-capable
> mock provider, the sync engine and the JMAP adapter all work, with 303 tests.
> Local search is next; there is no working client yet. See [`docs/STATUS.md`](docs/STATUS.md) for exactly where things
> stand and [`docs/BUILD_PLAN.md`](docs/BUILD_PLAN.md) for where they are going.

## Repository

```text
packages/
├── contracts/      types, schemas, error taxonomy, the eight seams   ✅
├── fixtures/       golden message corpus + expectations              ✅
├── mime/           RFC 5322/2045 parse, byte-preserving              ✅
├── threading/      JWZ threading, deterministic                      ✅
├── store/          SQLite schema, migrations, queries                ✅
├── adapter-mock/   deterministic fake server + fault injection       ✅
├── sync/           cursors, intent log, reconciliation               ✅
├── adapter-jmap/   JMAP provider (RFC 8620/8621)                     ✅
├── search/         FTS5 index and query grammar                      week 2
├── ui-core/        view models, command registry, keymap             week 3
├── web/            React shell                                       week 3
├── intelligence/   LLM providers, annotators, BYOK                   week 4
└── plugin-host/    extension loading, capability sandbox             week 4
apps/
└── dev-stalwart/   local JMAP server for development                 week 2
```

## Getting started

Requires Node ≥ 22.12 and pnpm 10.

```sh
pnpm install
pnpm check      # lint + typecheck + test — the inner loop
pnpm preflight  # everything CI runs, including the workflow's own steps
```

There is no build step for the libraries — internal packages resolve to their
TypeScript source.

## Branches

`develop` is the default and the integration branch — everything lands there
first. `main` is stable, and is only reached from `develop`, a `release/*` or a
`hotfix/*`. Working branches are `<type>/<slug>`: `feat/sync-intent-log`,
`fix/mime-charset-fallback`, `chore/bump-biome`. CI checks the name on every
pull request. Details in [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Documents worth reading first

| Document | What it covers |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | The invariants. Read before writing code. |
| [`docs/TECH_STACK.md`](docs/TECH_STACK.md) | Every stack decision, what it was chosen over, what would make us revisit it. |
| [`docs/BUILD_PLAN.md`](docs/BUILD_PLAN.md) | The 30-day agent-parallel roadmap. |
| [`BRAND.md`](BRAND.md) | Voice, vocabulary, visual direction. |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | How to contribute — fixtures especially. |

## Principles

**Ownership.** Your email is your data. Daak should never make you feel your
mailbox belongs to the application.

**Openness.** Open protocols over proprietary ecosystems. Replaceable providers.

**Local-first.** The network enhances the experience; it does not define it. The
client stays useful when the network disappears.

**Programmability.** Every meaningful action is a command — automatable,
extensible, integrable.

**User-controlled intelligence.** AI is a layer, not a dependency. You choose the
model, where it runs, what it sees, and what it may do. Your mail should never
require our AI.

## Licence

Split, deliberately: [`packages/contracts`](packages/contracts) is
**Apache-2.0**, so anyone can implement a provider, plugin or integration
against the interfaces freely. Everything else is **AGPL-3.0-or-later**, so a
hosted fork publishes its changes. Full explanation in
[`LICENSING.md`](LICENSING.md).
