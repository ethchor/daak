# @daak/fixtures

The golden corpus. Real-shaped messages plus what a correct parse must produce.

This package is the regression suite for the next decade. It outlives every
parser we will write, so it is optimised for longevity, not convenience.

## Scope

- `corpus/*.eml` — messages, byte-exact. Committed, immutable.
- `expected/*.json` — assertions per message, validated by `src/schema.ts`.
- `src/` — a loader. Nothing else. No parsing, no decoding.
- `tools/import-mbox.ts` — grow the corpus from public archives.

## Allowed imports

`node:fs`, `node:path`, `node:url`, `zod`, `@daak/contracts`.

## Forbidden

- Any parser, decoder, or MIME library. The corpus must not depend on the thing
  it tests.
- Editing a `.eml` file. Ever. If a fixture is wrong, add a new one and say in
  its description why the old one is kept. A corpus that gets adjusted until the
  code passes is not a corpus.
- Committing anything over 64KB. Large-message cases are generated at test time
  by `makeLargeMessage()`.
- Real people's mail. Public archives only, scrubbed.

## Expectations are assertions, not snapshots

`expected/*.json` records what MUST be true — decoded subject, structure,
attachment list — not a serialised parse tree. A full tree couples the corpus to
one parser's internals and has to be regenerated whenever they change, at which
point it stops testing anything and starts recording whatever happened last
Tuesday.

If you cannot say what a fixture asserts, it does not belong in the corpus.

## Growing it

Target is 300+ messages. Priority order for what is still missing:

1. More `malformed` — that is where parsers actually fail.
2. More non-UTF-8 charsets, especially CJK and Cyrillic.
3. Real threads, with their full reply chains, for `@daak/threading`.
4. Messages from mail clients nobody has run since 2006.

Import with `node tools/import-mbox.ts <file.mbox> <prefix>`, then fill in each
stub by hand. Stubs must never be committed.

## Test

    pnpm --filter @daak/fixtures test
