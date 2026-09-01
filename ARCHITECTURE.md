# Architecture

> Read this before writing code in this repository. Every package's `CLAUDE.md`
> assumes it.

Daak is a local-first mail system with a replaceable provider underneath and a
programmable command layer on top. The client is one consumer of that system,
not the system itself.

```
Provider (JMAP / IMAP / …)
   ↓
Sync engine          intent log, cursors, reconciliation
   ↓
Local mail system    blobs + events → messages, threads, search
   ├── Commands      one action layer
   ├── Rules         condition → commands
   ├── Intelligence  annotations, user-controlled
   ├── Plugins       capability-scoped
   └── Agents        the same commands, through explicit capabilities
        ↓
      User
```

All of the above except the last two lines is the Rust core, running as `daakd`.
The client is a consumer of it, and so is an agent.

---

## The invariants

These are rules, not preferences. Code that breaks one is wrong even when it
passes its tests, because the cost lands later — on the third reconnect, or on
the schema change two years from now.

### 1. Message blobs are immutable and content-addressed

A `BlobId` is `sha256:` plus the digest of the raw RFC 5322 bytes. Nothing
rewrites a blob. A "changed" message is a new blob.

This is what makes deduplication free, makes sync verifiable, and makes it
possible to re-derive everything else.

### 2. Every table other than `blobs` and `events` must be rebuildable from those two

`messages`, `threads`, `mailboxes`, search indexes, previews — all projections.
Dropping and rebuilding them is a routine operation, not a disaster recovery
procedure.

The practical consequence, and the one most often broken by accident: **an event
carries no derived data.** No subject lines, no previews, no thread ids. Replay
re-parses the blob. If you find yourself adding a field to an event so a
projector does not have to re-parse, you are trading this invariant for a
microsecond.

### 3. No provider-specific concept crosses the adapter boundary

JMAP state strings, IMAP UIDs, Gmail label semantics — all stop inside the
adapter. Above it there are opaque `providerId` strings and opaque `cursor`
strings, and nothing reads their contents.

The test: deleting `adapter-jmap` and writing `adapter-imap` should require zero
changes above the boundary.

### 4. All local mutations go through the intent log

No direct state writes. A mutation is recorded as an `Intent`, applied
optimistically to local state, then pushed. On rejection it is replayed and
reconciled.

Local and remote are never one transaction. Anything written as though they were
will corrupt state the first time the network disagrees.

### 5. Annotations are versioned and disposable

Deleting every annotation must cost nothing but recomputation. Anything that
cannot survive being dropped is not an annotation and does not belong there.

### 6. Extensions read core state and write only annotations

Nothing outside the core writes to `messages`, `blobs`, or `events`. Any plugin
must be deletable without a migration — which follows directly, because all it
ever wrote was disposable.

### 7. The ambiguous outcome is a state, not a guess

A request that timed out after leaving the machine may have succeeded
server-side. It is not applied and it is not rejected: it is `unknown`, and it
resolves by observing server state.

Every provider path and every reconciliation path must handle it explicitly. A
branch that handles the happy path and one error case is missing this one.

---

## The language boundary

The core is Rust. The client is TypeScript. They meet at `daakd` over JSON-RPC,
and at a contract defined once in Rust and generated into TypeScript.

```
┌─ TypeScript ────────────────────────────────┐
│  web            React + Radix shell         │
│  ui-core        keymap, palette, view models│
│  plugin-host    JS extensions, sandboxed    │
└───────────────────┬─────────────────────────┘
                    │  JSON-RPC / WebSocket (IPC under Tauri)
┌─ Rust ────────────┴─────────────────────────┐
│  daakd          the daemon, RPC + MCP       │
│  commands       the one action layer        │
│  sync           cursors, intents, reconcile │
│  store          SQLite, blobs + events      │
│  mime threading search                      │
│  provider       JMAP · mock · IMAP later    │
└─────────────────────────────────────────────┘
```

**The contract is generated, not mirrored.** `daak-contracts` is the only place a
persisted shape, error kind, capability or RPC message is defined. The
TypeScript is produced from it and committed; CI regenerates and fails on a diff.
Editing the generated file by hand is a red build, and so is changing the Rust
without regenerating.

This is the mitigation for the one real risk in a two-language stack. Do not
work around a generated type — change the Rust definition.

**Anything that must work with no UI open lives in the core.** Rules firing on
new mail, annotators, the MCP server, the command registry itself. An agent
should not need a browser tab to archive a message.

---

## Package boundaries

### Rust — `crates/`

| Crate | Owns | May depend on |
|---|---|---|
| `daak-contracts` | Types, error taxonomy, capabilities, traits. Source of truth | — |
| `daak-mime` | Parse and build RFC 5322/2045 | `contracts` |
| `daak-threading` | JWZ threading | `contracts` |
| `daak-store` | SQLite schema, migrations, queries | `contracts` |
| `daak-provider` | The `MailProvider` trait and shared helpers | `contracts` |
| `daak-adapter-mock` | Deterministic fake server + fault injection | `contracts`, `provider` |
| `daak-adapter-jmap` | JMAP provider | `contracts`, `provider` |
| `daak-sync` | Cursors, intent log, reconciliation | `contracts`, `store`, `mime`, `threading`, `provider` |
| `daak-search` | FTS5 index and query grammar | `contracts`, `store` |
| `daak-commands` | The command registry and core commands | `contracts`, `store`, `sync`, `search` |
| `daak-intelligence` | LLM providers, annotators | `contracts`, `store` |
| `daak-server` | `daakd`: RPC surface, rules runner, MCP | everything above |
| `daak-bindings` | Generates the TypeScript contract | `contracts` |

### TypeScript — `packages/`

| Package | Owns | May import |
|---|---|---|
| `contracts` | Generated types + a typed RPC client | — |
| `fixtures` | Golden corpus and expectations. Language-neutral | — |
| `ui-core` | Keymap, palette, view models | `contracts` |
| `web` | React shell | `ui-core`, `contracts` |
| `plugin-host` | Extension loading, capability sandbox | `contracts` |

Dependencies point one way in both halves. `sync` never depends on a concrete
adapter — it takes a `MailProvider`. `web` never speaks RPC directly — it goes
through `ui-core`.

**The corpus in `packages/fixtures` is shared by both languages.** It is `.eml`
files and JSON; each side has its own thin loader. Nothing about it is
TypeScript-specific, and nothing about it changes when a parser is rewritten.

## The command layer

Every meaningful action is a registered command: an id, a handler, a zod schema
for its arguments, a capability list, and metadata.

```
Command
├── id            mail.archive
├── args          zod schema — validated before the handler runs
├── capabilities  checked against the invoker first
├── keybinding    default, user-overridable
└── run(ctx, args)
```

The same command is invoked by keyboard shortcuts, the palette, the UI, rules,
plugins, and agents. One universal action layer, six front doors.

This is why a handler must run with no UI present. A command that needs the DOM
cannot be called by a rule at 3am, which defeats the point of the abstraction.

---

## Security model

- **Capabilities, no ambient authority.** Extension code gets exactly the object
  the host hands it, holding exactly what the user granted.
- **No implicit hierarchy.** `mail:read-body` does not imply `mail:read`.
  `draft:write` never implies `mail:send`. Ask for what you need.
- **Credentials never touch the store.** They live in the OS keychain; the store
  holds a reference. A stolen database file must not be a stolen mailbox.
- **Errors are public.** `DaakError.context` is logged, shipped to plugins, and
  shown to agents. No message content, no header values, no tokens.
- **Data exposure is declared before it happens.** An annotator states what it
  reads and whether its model is local or remote, and the user sees that before
  it runs.

---

## Performance budgets

Enforced in CI against a seeded 500k-message mailbox. A miss fails the build.

| Interaction | Budget |
|---|---|
| Keystroke → list update | 50ms |
| Open thread (cached) | 50ms |
| Local search, first results | 150ms |
| Cold start → interactive | 1s |
| Mailbox switch | 50ms |

Perceptual performance is tuned by feel against real data volumes, so these
numbers exist to catch regressions, not to define "fast enough".

---

## What this architecture is optimised for

The architecture that survives decades and the architecture several agents can
build in parallel are the same architecture. Both demand hard module boundaries,
explicit interfaces, no shared mutable state, and every module testable in
isolation without network or credentials.

"Future-proof" and "parallelisable" are the same property, viewed over different
time horizons.
