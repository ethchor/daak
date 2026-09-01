import type { z } from "zod";
import type { Capability, Invoker } from "../capabilities.js";
import type { SerializedDaakError } from "../errors.js";
import type { CommandId } from "../ids.js";
import type { Cancellable, Unsubscribe } from "../primitives.js";

/**
 * SEAM 4 — Command. The architectural centrepiece.
 *
 * Every meaningful action is a registered command. Keybindings map to command
 * ids, the palette lists them, rules invoke them, plugins register them, and
 * the agent surface calls them. One action layer, six front doors.
 *
 * Adding a feature means registering a command, not touching the UI tree.
 *
 * ## Rules
 *
 * - A command handler must be callable with no UI present. If it needs the
 *   DOM, it is not a command.
 * - `args` is a zod schema, and it is what makes commands safely callable by
 *   an agent: unvalidated arguments never reach a handler.
 * - `capabilities` are checked against the invoker BEFORE `run`. A handler may
 *   assume it holds every capability it declared.
 * - Undo is opt-in, but where it exists it is itself expressed as commands.
 */
export interface CommandContext extends Cancellable {
  readonly invoker: Invoker;
  /** Invoke another command, inheriting this invoker's capabilities. */
  readonly invoke: <T>(id: CommandId, args: T) => Promise<CommandResult>;
}

export type CommandResult =
  | { readonly status: "ok"; readonly message?: string; readonly undo?: UndoToken }
  | { readonly status: "noop"; readonly reason: string }
  | { readonly status: "error"; readonly error: SerializedDaakError };

/** Opaque handle the UI hands back to `command.undo`. */
export interface UndoToken {
  readonly commandId: CommandId;
  readonly payload: unknown;
}

export interface KeyBinding {
  /** Normalised chord, e.g. `mod+shift+a`, `g i`, `e`. `mod` is ⌘ or Ctrl. */
  readonly keys: string;
  /** Only active in this UI context, e.g. `list`, `thread`, `composer`. */
  readonly when?: string;
}

export interface CommandDefinition<TArgs = void> {
  readonly id: CommandId;
  readonly title: string;
  readonly category: string;
  readonly description?: string;
  /** Omit for commands taking no arguments. */
  readonly args?: z.ZodType<TArgs>;
  readonly defaultKeybindings?: readonly KeyBinding[];
  readonly capabilities: readonly Capability[];
  /** Hide/disable in the palette without unregistering. Must be cheap and pure. */
  readonly enabledWhen?: (ctx: CommandContext) => boolean;
  run(ctx: CommandContext, args: TArgs): Promise<CommandResult>;
}

export interface CommandRegistry {
  register<TArgs>(definition: CommandDefinition<TArgs>): Unsubscribe;
  get(id: CommandId): CommandDefinition<unknown> | undefined;
  list(): readonly CommandDefinition<unknown>[];
  /**
   * Validate args, check capabilities, run. Never throws for an expected
   * failure — it returns an `error` result. Throwing means a bug in the host.
   */
  execute(id: CommandId, args: unknown, invoker: Invoker): Promise<CommandResult>;
}
