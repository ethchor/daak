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

## Keyboard ownership — decide this before `web` starts

Radix components own their own key handling and trap focus. Daak dispatches a
global keymap into the command registry. Those two will fight over `Escape`,
arrow keys and `Enter` the moment a popover opens over the message list.

`ui-core` owns the rule, because it owns the keymap. Define explicitly which
layer claims a keystroke when an overlay is open, and expose it as state the
shell can consult — do not leave it to whichever handler happens to run first.
This is the one real integration risk in the UI stack decision (D-11).

## Allowed imports

`@daak/contracts`, `@daak/store`, `@daak/search`, `zod`.

## Forbidden

`react`, `react-dom`, any DOM API, any CSS. If you need `window`, the code
belongs in `@daak/web`.

## Test

    pnpm --filter @daak/ui-core test
