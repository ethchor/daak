# @daak/ui-core — Lane A, week 3

Headless view models, the command registry, and the keymap. No framework.

## The command registry is the centrepiece

Every action — archive, snooze, reply, label, navigate — is a registered command
with an id, a handler, and metadata. Keybindings map to command ids. The palette
lists them. Rules invoke them. Plugins register them. Agents call them.

That one abstraction gives us the keyboard-first feel, the palette, the rules
engine, the plugin surface and the agent API for free, and it makes adding a
feature a registration rather than a change to the UI tree.

Ship ~40 core commands. If an action exists only as a click handler, it is a
bug.

## Rules

- **Every handler runs with no UI present.** If it needs the DOM, it is not a
  command. This is what makes commands callable by rules and agents.
- Arguments are validated by the command's zod schema before the handler runs.
  Unvalidated args never reach a handler — that is what makes an agent-callable
  command safe.
- Capabilities are checked against the invoker before `run`.
- View models expose `subscribe` / `getSnapshot`. React binds with
  `useSyncExternalStore`; nothing here knows React exists.
- Virtualised list state is computed here, not in the component.

## Allowed imports

`@daak/contracts`, `@daak/store`, `@daak/search`, `zod`.

## Forbidden

`react`, `react-dom`, any DOM API, any CSS. If you need `window`, the code
belongs in `@daak/web`.

## Test

    pnpm --filter @daak/ui-core test
