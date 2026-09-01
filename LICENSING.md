# Licensing

Daak is split-licensed, deliberately. Two licences, one rule each.

| What | Licence | Why |
|---|---|---|
| `packages/contracts` | **Apache-2.0** | Anyone can implement against the interfaces — a provider, a plugin, an integration, an agent — without licence friction or legal review. |
| Everything else | **AGPL-3.0-or-later** | Someone running a hosted Daak must publish their changes. |

## What this means for you

**Writing a plugin, an adapter, or an integration?** You depend on
`@daak/contracts`, which is Apache-2.0. Your code is yours, under whatever
licence you like. This is the whole reason for the split — the interfaces are
meant to be built against freely, and an interface nobody can implement without
a legal conversation is not an open interface.

**Running Daak for yourself, your family, or your company?** Nothing is asked of
you. Self-hosting is the point of the project. The AGPL's network clause is
about distribution to *other people*, not about you running your own mail.

**Forking Daak and offering it as a hosted service?** Publish your changes. That
is the entire ask, and it is the reason the AGPL is here rather than a
permissive licence: Daak exists because mailboxes should not depend on a
company's permission, and that argument is hollow if the first well-funded
hosted fork can close the source.

**Working somewhere that bans AGPL dependencies?** Common, and worth knowing
about. You can still depend on `@daak/contracts` — Apache-2.0 — which is what
you would be importing to build against Daak anyway. Only the application itself
is AGPL.

## Copyright

    Copyright (c) 2026 The Daak Authors

Contributors keep copyright in their own contributions; there is no CLA and no
copyright assignment. If a legal entity is ever formed to hold the project, this
line changes and nothing else does.

## Adding a licence header

New files do not need a header — the `LICENSE` files govern by directory. If you
copy a file out of this repository into another project, carry the licence with
it.

## Third-party code

Dependencies keep their own licences. Anything vendored into this repository —
shadcn components copied into `packages/web`, for example — keeps its original
licence and attribution, recorded next to it.
