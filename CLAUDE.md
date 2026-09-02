# Daak — working agreement

Read `ARCHITECTURE.md` first. Then the `CLAUDE.md` of the package you are
working in. This file covers how work happens across the repo.

## The shape of the project

Daak is an open, local-first, programmable email client. One package per lane,
one agent per package per session. Dependencies point one way, and the table in
`ARCHITECTURE.md` is the authority on which way.

## Rules

**One agent, one package, one PR.** A change that spans packages goes to the
owner rather than into a single diff.

**`@daak/contracts` is locked.** Wanting to change an interface is a signal to
stop and think, not a diff to open. Nine times in ten it means a bug in your own
package. If it really is the contract, raise it — do not work around it, and do
not widen a type to make an error go away.

**Tests before implementation** in `sync`, `mime`, and `store`. Write the
property or fixture tests, get those reviewed, then implement against them.
Reviewing a test suite is far cheaper than reviewing an implementation.

**Never edit a fixture to make a test pass.** The corpus is the spec. If a
fixture is genuinely wrong, add a new one and explain in its description why the
old one stays.

**Handle the ambiguous case explicitly.** A request that timed out after leaving
the machine may have succeeded. If a branch handles the happy path and one error
case, it is missing this, and it is the bug most likely to survive review.

**No secrets anywhere but the OS keychain.** Not in the store, not in a config
file, not in a log line, not in a `DaakError.context` — errors get shipped to
plugins and agents.

## Branches

`develop` is the integration branch and the default. `main` is stable and is
only reached from `develop`, a `release/*` or a `hotfix/*`.

Work on a short-lived `<type>/<slug>` branch — `feat/`, `fix/`, `refactor/`,
`perf/`, `test/`, `docs/`, `chore/`, `spike/` — and merge into `develop` as soon
as it is green. CI checks the name on every pull request. Do not batch unrelated
work to make a bigger pull request; a branch that lives a week is a merge
conflict being written in slow motion.

## Before you push

    pnpm preflight

**Run it. Every time.** It is not `pnpm check` with extra steps — it catches a
class of failure that nothing else local will:

- It executes the `run:` steps read out of `.github/workflows/ci.yml` itself, so
  there is no second copy of the command list to drift from CI.
- It runs `pnpm install --frozen-lockfile`, which is what CI does. A plain
  `pnpm install` locally *fixes* a stale lockfile instead of failing on it, so
  the problem only ever appears on the runner.
- It lints the workflow's `uses:` steps, which cannot be executed locally. The
  first CI run this repo ever had failed because the pnpm version was declared
  both in `package.json#packageManager` and as an action input; preflight now
  refuses that combination by name.

`pnpm check` (lint, typecheck, test) is the faster inner loop while you work.
`pnpm preflight` is the gate before the push. If you touched a package with
property tests — `sync`, `store`, `threading` — also run:

    pnpm soak

Preflight runs the tests once, because that is what CI does, and once is not
enough for a property suite: each run explores a different slice of the input
space. The sync engine passed 200 property cases locally and failed on its first
CI run, on a real counterexample. If you touched one package:

    pnpm --filter @daak/<package> test

**A red CI run is fixed before anything else.** Not after the next change, not
alongside it. A pipeline people expect to be red stops being a signal.

## Style

Match the surrounding code. It is deliberately plain: no clever abstractions, no
inheritance, functions over classes except where a class carries real state.

Comments explain **why**, and are worth writing where the reason is not
recoverable from the code — an invariant being upheld, a real-world quirk being
accommodated, a tempting simplification that is wrong. Do not narrate what the
next line does.

## Voice, for anything users read

Error messages, UI copy, docs, commit messages. See `BRAND.md` §22–23.

Intelligent, calm, direct. Say "Couldn't reach mail.example.org — retrying in
30s", not "Oops! Something went wrong 😅". Prefer: mail, mailbox, message,
thread, command, rule, provider, local, own, connect, automate, extend, agent.
Avoid: inbox zero, AI-powered, seamless, revolutionary, next-gen.

## Commits

Explain why the change is what it is, not what the diff already shows. If a
decision has a trade-off, name it. If something is deliberately left undone, say
so.
