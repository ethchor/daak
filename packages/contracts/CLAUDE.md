# @daak/contracts

The constitution, in TypeScript. Every package depends on this one.

## Scope

Types, zod schemas for persisted shapes, the error taxonomy, the capability
model, and the eight seam interfaces. Declarations only.

## Allowed imports

`zod`. That is the entire list.

## Forbidden

- Any other dependency. This package ships to the browser, the worker, the
  server and every plugin; whatever you add goes everywhere.
- Implementation. No parsing, no I/O, no defaults that do work. A helper that
  normalises a value in one obvious way (`normaliseKeywords`) is fine; anything
  with a branch on environment is not.
- **Changing an interface after week 0 without the owner in the loop.** An agent
  that wants to modify a contract has almost always found a bug in its own
  package. Stop and ask. This is the single rule that keeps the lanes from
  drifting.

## Invariants this package encodes

- Blobs are content-addressed and immutable — `BlobId` is the digest.
- Every table but `blobs` and `events` is rebuildable from those two, which is
  why `EventPayload` carries no derived fields.
- All local mutations go through the intent log — `IntentSchema`.
- No provider concept crosses the adapter boundary — provider ids are plain
  strings in `providerId` fields and nothing above the adapter reads them.
- Extensions read core state and write only annotations.
- The ambiguous outcome is `unknown`, never a guess.

## Test

    pnpm --filter @daak/contracts test
