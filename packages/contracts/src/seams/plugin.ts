import { z } from "zod";
import { CapabilitySetSchema } from "../capabilities.js";
import { PluginIdSchema } from "../ids.js";
import type { Unsubscribe } from "../primitives.js";
import type { Annotator } from "./annotator.js";
import type { DaakApi } from "./api.js";
import type { CommandDefinition, CommandRegistry } from "./command.js";
import type { Rule } from "./rule.js";

/**
 * Plugins.
 *
 * A plugin declares what it wants in a manifest, the user grants it, and the
 * host hands back an API object holding exactly those capabilities and nothing
 * else. There is no global to reach for.
 *
 * The deletability rule (ARCHITECTURE.md): removing a plugin must never require
 * a migration. That follows from the write restriction — a plugin only ever
 * wrote annotations, and annotations are disposable.
 */
export const PLUGIN_API_VERSION = 1;

export const PluginManifestSchema = z.object({
  id: PluginIdSchema,
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().default(""),
  /** Host API version the plugin was built against. Refused when incompatible. */
  apiVersion: z.number().int().positive(),
  /** Module entry point, resolved relative to the plugin root. */
  entry: z.string().min(1),
  /** Requested up front, granted by the user, enforced on every call. */
  capabilities: CapabilitySetSchema,
  contributes: z
    .object({
      commands: z.array(z.string()).default([]),
      annotators: z.array(z.string()).default([]),
      views: z.array(z.string()).default([]),
      rules: z.array(z.string()).default([]),
    })
    .default({ commands: [], annotators: [], views: [], rules: [] }),
});
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

/** What a plugin's `activate` receives. The whole of its authority. */
export interface PluginApi {
  readonly manifest: PluginManifest;
  /** Read-only core access, capability-filtered. */
  readonly mail: DaakApi;
  readonly commands: Pick<CommandRegistry, "register" | "list">;
  registerAnnotator(annotator: Annotator): Unsubscribe;
  registerRule(rule: Rule): Unsubscribe;
  readonly log: (message: string) => void;
}

export interface Plugin {
  activate(api: PluginApi): Promise<void> | void;
  deactivate?(): Promise<void> | void;
}

export interface LoadedPlugin {
  readonly manifest: PluginManifest;
  readonly commands: readonly CommandDefinition<unknown>[];
  readonly annotators: readonly Annotator[];
}

export interface PluginHost {
  load(manifest: PluginManifest, module: Plugin): Promise<LoadedPlugin>;
  unload(id: PluginManifest["id"]): Promise<void>;
  list(): readonly LoadedPlugin[];
}
