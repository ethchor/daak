# @daak/intelligence — Lane B, week 4

`LLMProvider` implementations, BYOK key handling, and the first annotators.

## The principle this package must not violate

**Daak works fully with no model configured.** Nothing here is on a critical
path. If removing this package breaks reading, searching, or sending mail, the
dependency is backwards.

## Done when

Two providers (one remote, one local via Ollama) and two annotators (triage,
summarise) work end to end, and disabling both leaves every other feature
untouched.

## Rules

- **Declare data exposure up front.** An annotator's `requires` list is what the
  UI shows the user before it runs. Requesting `text-body` and quietly reading
  headers too is a privacy bug, not a shortcut.
- **Keys live in the OS keychain**, never in the store, never in a config file,
  never in a log line, never in an error `context`.
- **`residency` is honest.** A provider pointed at a remote endpoint is
  `remote`, whoever operates it.
- Annotator output is versioned. Bump `version` whenever output would change for
  the same input, or stale annotations linger with no way to detect them.
- No model call happens without an explicit user action or an explicitly enabled
  rule. No background enrichment on by default.

## Allowed imports

`@daak/contracts`, an official SDK per provider, `zod`.

## Forbidden

Writing anywhere but `annotations`. Intelligence is an annotator, not an author.

## Test

    pnpm --filter @daak/intelligence test
