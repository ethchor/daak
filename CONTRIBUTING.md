# Contributing to Daak

Daak is an open, local-first, programmable email client. Contributions are
welcome — especially fixtures, adapters, and bug reports from real mailboxes.

## Getting set up

Requires Node ≥ 22.12 and pnpm 10.

    pnpm install
    pnpm check          # lint + typecheck + test — the inner loop
    pnpm preflight      # everything CI runs — the gate before you push

There is no build step for the libraries: internal packages resolve to their
TypeScript source. Only the web app builds, via Vite.

## Repository map

| Path | What it is |
|---|---|
| `ARCHITECTURE.md` | The invariants. Read before writing code. |
| `BRAND.md` | Voice, vocabulary, visual direction. |
| `docs/TECH_STACK.md` | Every stack decision and what would make us revisit it. |
| `docs/BUILD_PLAN.md` | The 30-day roadmap. |
| `packages/*/CLAUDE.md` | Per-package scope, allowed imports, done-criteria. |

## What we especially want

**Fixtures.** The corpus in `packages/fixtures` is the most valuable thing in
this repository, and it is nowhere near big enough. If you have a message that
breaks a mail client — a mislabeled charset, an unclosed boundary, a
1990s-vintage attachment — that message is a contribution. Public archives only,
scrubbed of anything identifying a private individual. See
`packages/fixtures/CLAUDE.md`.

**Bug reports with the message attached.** "Renders wrong" is hard to act on. A
`.eml` that reproduces it is a fix.

**Provider adapters.** The `MailProvider` interface is small on purpose.

## Branches

Two long-lived branches:

| Branch | What it is |
|---|---|
| `develop` | The integration branch, and the default. Everything lands here first. |
| `main` | Stable. Only ever reached from `develop`, a `release/*`, or a `hotfix/*`. |

Everything else is short-lived and named `<type>/<slug>`:

```
feat/sync-intent-log        a new capability
fix/mime-charset-fallback   a bug fix
refactor/store-projectors   behaviour unchanged
perf/list-virtualisation    faster, same behaviour
test/threading-properties   tests only
docs/architecture-invariants documentation only
chore/bump-biome            tooling, dependencies, CI
spike/opfs-at-500k          timeboxed investigation, never merged as-is
release/0.1.0               release preparation, develop → main
hotfix/0.1.1                urgent fix, branched from main
```

CI enforces this on every pull request. The point is not tidiness: the branch
name is the cheapest signal a reviewer gets about what kind of change is coming
before they open the diff.

## Merging

**Short-lived branches, merged as soon as they are green.** A branch that lives
for a week is a merge conflict being written in slow motion, and with several
lanes running in parallel it is also five other people's work going stale.

Land on `develop` the moment `pnpm check` passes and the change stands on its
own — do not batch unrelated work to make a bigger pull request.

`main` moves when a meaningful chunk of `develop` is worth calling stable, not
on a schedule.

## Pull requests

- One package per PR where possible. It is what makes review tractable.
- Tests with the change. For `sync`, `mime` and `store`, tests **before** the
  change.
- `pnpm preflight` green, not just `pnpm check`. Preflight runs the workflow's
  own steps plus a frozen lockfile install, and lints the parts of the workflow
  that cannot be executed locally. It exists because the first CI run this repo
  ever had failed on a workflow that had never been executed.
- Explain why in the description. The diff already says what.

## Changing `@daak/contracts`

`contracts` is locked. It is the interface every other package is written
against, and a change there ripples everywhere.

If you think an interface is wrong, **open an issue before writing the code.**
Almost every request to change a contract turns out to be a problem solvable
inside the package that raised it. The remaining ones are real and worth
discussing properly.

## Invariants that are not up for debate in a PR

These are in `ARCHITECTURE.md` with full reasoning. In short:

1. Blobs are immutable and content-addressed.
2. Everything but `blobs` and `events` is rebuildable from those two.
3. No provider concept crosses the adapter boundary.
4. All local mutations go through the intent log.
5. Annotations are versioned and disposable.
6. Extensions read core state and write only annotations.
7. The ambiguous outcome is a state, not a guess.

A PR that breaks one of these will get a request for changes even if it works.
The cost of these lands later — on the third reconnect, or on the schema change
two years out — which is exactly why they need defending now.

## Licence

Daak is split-licensed: `packages/contracts` is Apache-2.0, everything else is
AGPL-3.0-or-later. See `LICENSING.md` for what that means in practice — the
short version is that you can build against the interfaces under any licence you
like, and a hosted fork of the application publishes its changes.

Contributions are accepted under the licence of the directory they land in.
There is no CLA and no copyright assignment; you keep copyright in your own
work.
