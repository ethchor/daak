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

## Package boundaries

| Package | Owns | May import |
|---|---|---|
| `contracts` | Types, schemas, errors, capabilities, seams | `zod` |
| `fixtures` | Golden corpus and expectations | `contracts` |
| `mime` | Parse and build RFC 5322/2045 | `contracts` |
| `threading` | JWZ threading | `contracts` |
| `store` | SQLite schema, migrations, queries | `contracts` |
| `sync` | Cursors, intent log, reconciliation | `contracts`, `store`, `mime`, `threading` |
| `adapter-mock` | Deterministic fake server + faults | `contracts`, `fixtures` |
| `adapter-jmap` | JMAP provider | `contracts` |
| `search` | FTS5 index and query grammar | `contracts`, `store` |
| `intelligence` | LLM providers, annotators | `contracts` |
| `ui-core` | View models, command registry, keymap | `contracts`, `store`, `search` |
| `plugin-host` | Loading, capability sandbox | `contracts` |
| `web` | React shell | `ui-core`, `contracts` |

Dependencies point one way. `sync` never imports an adapter — it talks to
`MailProvider`. `web` never imports `store` — it talks to `ui-core`.

`contracts` is **locked**. Changing it after week 0 needs the owner in the loop;
an agent that wants to change an interface has almost always found a bug in its
own package instead.

---

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

Measured by `apps/dev-stalwart` against a seeded mailbox. **Not yet enforced in
CI**: the numbers come from whatever machine ran them, and a gate needs a runner
whose variance is known. Where each stands today, and the one that is missed by
a wide margin, is in `docs/STATUS.md`.

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
