# @daak/mime — Lane A, week 1

RFC 5322 / 2045 parse and build. Pure functions. No I/O, no network, no clock.

## Done when

The whole corpus parses, no fixture throws, and `build(parse(bytes))` returns
the original bytes for every fixture that round-trips.

## Wrap, don't write

Agents write plausible MIME parsers. Nobody writes a correct one first time.
Start from a maintained library, wrap it behind our own types, and use the
corpus to prove the wrapper. `postal-mime` (parse, works in browser and Node)
and `mimetext` (build) are the current candidates — evaluate both against the
corpus before committing to either, and record the outcome in
`docs/TECH_STACK.md`.

The wrapper is the point: it is what lets us replace the library in 2029
without touching anything else.

## Allowed imports

`@daak/contracts`, `@daak/fixtures` (tests only), one parse library, one build
library.

## Forbidden

- `node:fs`, `node:net`, anything environment-specific. This runs in a browser
  worker.
- Mutating input bytes. Parsing is a projection; the blob stays canonical.
- Throwing on malformed input. Real mail is malformed. Degrade — return what you
  could parse, flag what you could not — and only throw for input that is not a
  message at all.
- Normalising line endings, re-encoding, or "fixing" a charset label on the way
  through.

## The hard parts, in the order they will bite

1. Charset decoding for labels that are wrong (declared latin-1, actually cp1252
   — decode as cp1252, everyone else does).
2. RFC 2047 words split mid-character across encoded words.
3. Boundaries that never close.
4. `message/rfc822` nesting without leaking inner headers to the outer message.
5. Deciding what counts as an attachment: `inline` + a `cid:` reference in the
   HTML is not one.

## Test

    pnpm --filter @daak/mime test
