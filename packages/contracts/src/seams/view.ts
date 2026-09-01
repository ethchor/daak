import type { Capability } from "../capabilities.js";

/**
 * SEAM 6 — View.
 *
 * `ui-core` is headless and framework-agnostic; `web` binds `TNode` to
 * React nodes. Keeping the generic here is what stops React leaking into
 * packages that must also run in a worker or on a server.
 */
export type ViewSlot =
  | "message-list"
  | "thread"
  | "sidebar"
  | "composer"
  | "detail-panel"
  | "status-bar";

export interface ViewRenderer<TProps, TNode> {
  readonly id: string;
  readonly slot: ViewSlot;
  readonly title: string;
  /** Higher wins when several renderers claim a slot. Core ships at 0. */
  readonly priority: number;
  readonly capabilities: readonly Capability[];
  render(props: TProps): TNode;
}
