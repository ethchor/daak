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

> **Status: week 0.** The stack is settled, the corpus exists, and the contract
> design is proven — but the core is being written in Rust and that port has
> just begun. There is no working client yet. See [`docs/STATUS.md`](docs/STATUS.md) for exactly where things
> stand and [`docs/BUILD_PLAN.md`](docs/BUILD_PLAN.md) for where they are going.

## Repository

```text
crates/                     the Rust core — daakd
├── daak-contracts/         types, taxonomy, traits. Source of truth
├── daak-mime/              RFC 5322/2045, byte-preserving
├── daak-threading/         JWZ threading
├── daak-store/             SQLite: blobs + events, everything else derived
├── daak-provider/          the MailProvider trait
├── daak-adapter-mock/      deterministic fake server + fault injection
├── daak-adapter-jmap/      JMAP (RFC 8620/8621)
├── daak-sync/              cursors, intent log, reconciliation
├── daak-search/            FTS5 index and query grammar
├── daak-commands/          the command registry
├── daak-intelligence/      LLM traits, annotators, BYOK
├── daak-server/            daakd: RPC, rules, MCP
└── daak-bindings/          generates the TypeScript contract
packages/                   the TypeScript client
├── contracts/              generated types + typed RPC client
├── fixtures/               golden message corpus                        ✅
├── ui-core/                keymap, palette, view models
├── plugin-host/            extension loading, capability sandbox
└── web/                    React + Radix shell
apps/
├── dev-stalwart/           local JMAP server for development
└── desktop/                Tauri shell (later)
```

## Getting started

Requires Rust 1.94+, Node ≥ 22.12 and pnpm 10.

```sh
cargo test           # the core
pnpm install
pnpm check           # lint + typecheck + test, the client
```

There is no build step for the TypeScript libraries — internal packages resolve
to their source. The contract types under `packages/contracts/src/generated` are
produced by `cargo run -p daak-bindings` and committed; CI fails if regenerating
them produces a diff.

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

Not yet settled — see the open decision in [`docs/TECH_STACK.md`](docs/TECH_STACK.md).
The project will be released under an OSI-approved licence, with the interface
package under a permissive one.
