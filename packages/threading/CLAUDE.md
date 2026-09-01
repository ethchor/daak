# @daak/threading — Lane B, week 1

JWZ threading. Pure, deterministic, total.

## Done when

Threads match expected output for every threading fixture, including the ones
with no References and the one with a duplicate Message-ID.

## Rules

- Same input, same output, always. No `Date.now()`, no iteration over a `Set`
  whose order came from insertion, no reliance on input array order.
- Thread ids are derived from content, not assigned by a counter. Re-running on
  a rebuilt store must produce identical ids.
- Provider thread ids are never used to decide grouping. Providers disagree with
  each other and with themselves, and a thread that reshapes when you switch
  provider is a bug users can see.
- Subject-based fallback only after References and In-Reply-To are exhausted.
  It is the step that wrongly merges unrelated mail — keep it last and keep it
  narrow.

## Allowed imports

`@daak/contracts`, `@daak/fixtures` (tests only). No runtime dependencies.

## Forbidden

Reading message bodies. Threading is a header-only algorithm; if you need the
body you have taken a wrong turn.

## Test

    pnpm --filter @daak/threading test
