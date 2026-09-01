# dev-stalwart

A local JMAP mail server to develop against, plus the seeding tooling for
performance work.

Owned by week 2, lane D. Everything here except this document is scaffolding.

## Run it

    cp .env.example .env
    docker compose up -d

Then the JMAP session resource is at
`http://localhost:8080/.well-known/jmap`, and the admin UI at
`http://localhost:8080`.

## Why Stalwart

JMAP-native, self-hostable, one container. It is also the server most likely to
be on the other end for early self-hosting users, so the numbers we tune against
are the numbers they will see. See `docs/TECH_STACK.md` D-08.

## Seeded mailboxes (week 2)

Three sizes, because the interesting problems only appear at the largest:

| Size | For |
|---|---|
| 1k | Everyday development. Fast to reset. |
| 50k | Search relevance and index build times. |
| 500k | The CI performance budgets in `ARCHITECTURE.md`. |

The seeder should generate messages with realistic shape — thread depth,
attachment ratios, charset spread, list mail proportion — rather than 500k
copies of one message, which makes every index look better than it is.

Draw the message shapes from `@daak/fixtures` so the seeded corpus exercises the
same edge cases at volume.

## Not yet done

- The seeder itself.
- Verified account provisioning steps (the compose file is untested).
- A one-command "Daak + Stalwart" compose for self-hosters — that is days 60–90,
  and it is what makes self-hosting actually spread.
