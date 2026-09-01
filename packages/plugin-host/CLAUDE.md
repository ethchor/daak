# @daak/plugin-host — Lane C, week 4

Extension loading, manifests, and the capability sandbox.

## Done when

A plugin can register a command and write an annotation, cannot read a body it
did not request, and can be deleted without a migration.

## Rules

- **No ambient authority.** A plugin gets exactly the object the host hands it.
  No globals, no reaching for the store, no `import` of core packages at
  runtime.
- Capabilities are granted by the user against the manifest and enforced on
  every call, not just at load.
- **Plugins write only to `annotations`.** Nothing outside the core writes to
  `messages`, `blobs`, or `events`. This is what makes uninstall a delete rather
  than a migration.
- A plugin that throws during activation is disabled, not retried in a loop, and
  the failure is visible to the user.
- Version the host API. Refuse a plugin built against an incompatible one rather
  than half-supporting it.

## Allowed imports

`@daak/contracts`, `zod`.

## Test

    pnpm --filter @daak/plugin-host test
