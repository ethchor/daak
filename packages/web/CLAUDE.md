# @daak/web — Lane B, week 3

React shell over `@daak/ui-core`. Dark, fast, keyboard-first.

## Done when

Open the app, see real mail from the dev Stalwart instance, navigate entirely by
keyboard, search locally, and work offline with the network off.

## Rules

- **Components render; they do not decide.** Every action dispatches a command
  by id. A component that contains business logic has taken work that belongs in
  `ui-core`, where it can be tested without a DOM.
- Keyboard first. Every action reachable by mouse is reachable by key, and the
  palette lists everything.
- The message list is virtualised from the first commit. It will hold 500k rows.
- Interaction latency budget is enforced in CI. Sub-50ms is a build failure when
  missed, not an aspiration.
- Theme via CSS custom properties from `brand/tokens.css`. No hard-coded colours
  anywhere in a component.

## Allowed imports

`@daak/ui-core`, `@daak/contracts`, `react`, `react-dom`, a virtualiser.

## Forbidden

- Importing `@daak/store`, `@daak/sync`, or any adapter directly. The web shell
  talks to `ui-core`.
- Business logic in a component.
- A new colour that is not a token.

## Test

    pnpm --filter @daak/web test
