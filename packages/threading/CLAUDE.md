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
  narrow. Two narrowings are in place and both earn their keep:

  **At least one side must carry a reply prefix.** Two messages both titled
  "Lunch" with no reply relationship stay apart; "Lunch" and "Re: Lunch" come
  together. Without this, subject grouping merges every "Hello" anyone ever sent
  into one enormous thread.

  **A forward takes part in neither direction.** "Fwd: numbers" is usually the
  same text sent to a new audience for a new reason, so it does not join the
  conversation it quotes — and it must not become the thread a later reply joins
  either, or "Re: numbers" lands on someone's forward instead of the original.

## Allowed imports

`@daak/contracts`, `@daak/fixtures` (tests only). No runtime dependencies.

## Forbidden

Reading message bodies. Threading is a header-only algorithm; if you need the
body you have taken a wrong turn.

## Known behaviour worth understanding before changing it

**A late-arriving ancestor re-roots a thread and changes its id.** Thread ids
derive from the root's Message-ID, which is stable as a thread grows downwards.
It is not stable when a message arrives that is an ancestor of the current root.
That is real and unavoidable — it is the same event that makes every mail client
suddenly merge two conversations — and the store handles it as a merge rather
than the threading code pretending it did not happen.

**A duplicated Message-ID means whoever arrives first owns it.** Two distinct
messages sharing an id is malformed input, and there is no principled way to
know which one a third message replying to that id meant. Both survive as
distinct messages; which thread they land in depends on received order, and that
is the honest answer rather than a guessed one.

## Test

    pnpm --filter @daak/threading test
