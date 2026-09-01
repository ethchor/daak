# @daak/mime — Lane A, week 1

RFC 5322 / 2045 parse and build. Pure functions. No I/O, no network, no clock.

## Done when

The whole corpus parses, no fixture throws, and `build(parse(bytes))` returns
the original bytes for every fixture that round-trips.

## Wrap, don't write

`postal-mime` does the decoding. This package owns the policy.

The library was evaluated against the whole corpus before adoption (see
`docs/TECH_STACK.md` D-09): it is sound on charsets, encoded words, transfer
encodings, unclosed boundaries and nesting. What it does not do is decide what
counts as an attachment, refuse a nonsense date, or expose the part tree — and
those are this package's job.

The wrapper is the point: it is what lets the library be replaced in 2029
without touching anything else.

## The policy this package owns

Each rule exists because a fixture says so. Change one and the corpus will tell
you.

- An inline part referenced by `cid:` is rendered, not listed. A paperclip on
  every newsletter is a small bug that erodes trust in the whole list view.
- A detached signature (`pkcs7`, `pgp`) is protocol, not a file.
- `text/calendar` carried as an alternative body is the invite; one a user
  actually attached has `Content-Disposition: attachment` and stays an
  attachment.
- An attachment the sender never named still gets a stable display name.
- An unparseable `Date` yields no `sentAt`. Never substitute the current time —
  that silently reorders someone's mailbox.
- Address groups flatten to their members. A reply-all that drops two recipients
  is unforgivable.
- Malformed input produces `warnings`, not an exception. Only input that is not
  a message at all throws.

## Allowed imports

`@daak/contracts`, `postal-mime`, `@daak/fixtures` (tests only). A build library
joins this list when the compose lane starts in week 4.

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
