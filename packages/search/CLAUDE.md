# @daak/search — Lane C, week 2

FTS5 indexing and the query grammar. No AI in this package.

## Done when

`from:asha has:attachment after:2026-01-01 invoice` parses to a filter tree and
returns correct results against the 500k-message seeded mailbox, under the
latency budget in CI.

## Scope

- Query grammar: `from:`, `to:`, `subject:`, `has:attachment`, `is:unread`,
  `in:<mailbox>`, `before:`/`after:`, quoted phrases, `-negation`.
- FTS5 index maintenance as a projection over `events`.
- Ranking. Recency matters more than BM25 alone for mail; tune against real
  volumes.

## Rules

- The parser is total: any input string produces a query, never an exception.
  Unparseable fragments fall back to full-text terms — a user typing `from:` and
  stopping must not see an error.
- The index is a projection. Dropping and rebuilding it must be routine.
- Natural-language → filter translation is a separate layer in
  `@daak/intelligence` that emits this package's filter tree. Search itself
  never calls a model.

## Allowed imports

`@daak/contracts`, `@daak/store`.

## Test

    pnpm --filter @daak/search test
