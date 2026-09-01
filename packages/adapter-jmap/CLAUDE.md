# @daak/adapter-jmap — Lane B, week 2

JMAP provider, RFC 8620 (core) and RFC 8621 (mail). Well-specified, which makes
it good agent work — but validate against a real Stalwart, not just the spec.

## Done when

The same conformance suite that `adapter-mock` passes also passes here against
`apps/dev-stalwart`, including cursor expiry and partial-batch failures.

## Rules

- **No JMAP vocabulary leaves this package.** No `Email/get`, no `/query`, no
  JMAP state strings in any type that crosses the boundary. State strings become
  opaque `cursor` values.
- Use `Foo/changes` for the tail lane and `Foo/query` for backfill. Never poll
  a full query for the tail.
- Batch to the server's advertised `maxObjectsInGet`, not to a number you chose.
- Map every JMAP `SetError` type onto the error taxonomy explicitly. A default
  branch that returns `permanent` for an unrecognised error type will strand
  intents.
- `stateMismatch` is `conflict`, not `permanent`. Getting this wrong means the
  engine never resynchronises.

## Allowed imports

`@daak/contracts`, `fetch`. No JMAP client library — the protocol is JSON over
HTTP, and we want exact control of state strings and batching.

## Test

    pnpm --filter @daak/adapter-jmap test
