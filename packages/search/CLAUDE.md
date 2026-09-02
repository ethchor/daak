# @daak/search — Lane C, week 2

FTS5 indexing and the query grammar. No AI in this package.

## Done when

`from:asha has:attachment after:2026-01-01 invoice` parses to a filter tree and
returns correct results against the 500k-message seeded mailbox, under the
latency budget in CI.

**Half done.** The grammar, the index and the ranking work and are tested. What
has not happened is the second half of that sentence: nothing has been run
against a large mailbox, so every performance claim here is a guess. The seeded
mailboxes are lane D.

## Scope

- Query grammar: `from:`, `to:`, `subject:`, `has:attachment`, `is:unread`,
  `in:<mailbox>`, `before:`/`after:`, quoted phrases, `-negation`.
- FTS5 index maintenance as a projection over `events`.
- Ranking. Recency matters more than BM25 alone for mail; tune against real
  volumes.

## Decisions worth knowing before changing them

**Every FTS5 term is escaped into a literal.** Unescaped, `OR`, `NEAR(` and `*`
are syntax errors from SQLite — and a search box that errors on the word "OR" is
broken. The cost is that FTS5's own operator syntax is unavailable to users,
which is the right trade for a mail client.

**A query with no text never touches FTS5.** `in:inbox is:unread` has nothing to
rank; sending an empty match expression would return nothing at all. It becomes
an ordinary indexed query over `messages`, ordered newest first.

**Recency is subtracted from bm25, and it decays.** Mail is not documents: a
mediocre match from this morning usually beats a perfect one from 2019. The
decay is smooth rather than stepped, because a cliff at "30 days" reorders
someone's results overnight for no reason they can see. `recencyWeight: 0` turns
it off.

**Search joins `messages`.** A stale index can therefore only under-return,
never invent a hit for a message that is gone.

**The FTS table's schema lives in `@daak/store`.** The store owns every table so
migrations stay in one ordered, reversible place; this package owns what goes
into it and how it is queried. A store rebuild empties the index, and refilling
it needs body text that only the app can produce — documented behaviour, not a
bug.

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
