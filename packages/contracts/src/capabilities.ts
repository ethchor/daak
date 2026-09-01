import { z } from "zod";

/**
 * Capabilities are the whole security model.
 *
 * Nothing outside the core reads mail or runs a command without holding the
 * capability for it — that applies equally to a plugin, an annotator, a rule
 * and an agent. There is no ambient authority: an extension that was granted
 * nothing can do nothing.
 *
 * The rule that keeps the seams honest (ARCHITECTURE.md §Extensions):
 * an extension may READ core state through the public API and WRITE only to
 * `annotations`.
 */
export const CORE_CAPABILITIES = [
  /** Read message and thread metadata (headers, flags, structure). */
  "mail:read",
  /** Read decoded message bodies and attachment bytes. Strictly more than `mail:read`. */
  "mail:read-body",
  /** Run local search queries. */
  "mail:search",
  /** Read raw blobs by id. */
  "blob:read",
  /** Read annotations written by any producer. */
  "annotation:read",
  /** Write annotations within the holder's own namespace. The only write a plugin gets. */
  "annotation:write",
  /** Create and modify local drafts. */
  "draft:write",
  /** Submit mail. Always a separate, explicit grant — never implied by `draft:write`. */
  "mail:send",
  /** Contribute commands, views or rules to the registry. */
  "registry:contribute",
  /** Subscribe to core state changes. */
  "state:subscribe",
] as const;

export type CoreCapability = (typeof CORE_CAPABILITIES)[number];

/**
 * Parameterised capabilities. The argument is matched literally or against a
 * trailing `*` wildcard, so `command:invoke:mail.*` grants `mail.archive`.
 */
export type ParameterisedCapability = `command:invoke:${string}` | `net:fetch:${string}`;

export type Capability = CoreCapability | ParameterisedCapability;

const PARAMETERISED_PREFIXES = ["command:invoke:", "net:fetch:"] as const;

export const isCapability = (value: string): value is Capability =>
  (CORE_CAPABILITIES as readonly string[]).includes(value) ||
  PARAMETERISED_PREFIXES.some((p) => value.startsWith(p) && value.length > p.length);

export const CapabilitySchema = z.string().refine(isCapability, {
  message: "unknown capability",
}) as unknown as z.ZodType<Capability>;

export const CapabilitySetSchema = z.array(CapabilitySchema).readonly();

/**
 * Does `granted` satisfy `required`?
 *
 * Matching is exact, except that a parameterised capability may end in `*`,
 * which matches any suffix. There is no implicit hierarchy: holding
 * `mail:read-body` does not grant `mail:read`. Ask for both.
 */
export const grants = (granted: readonly Capability[], required: Capability): boolean => {
  for (const held of granted) {
    if (held === required) return true;
    if (held.endsWith("*")) {
      const prefix = held.slice(0, -1);
      // A wildcard only ever widens within its own parameterised namespace.
      if (prefix.includes(":") && required.startsWith(prefix)) return true;
    }
  }
  return false;
};

export const grantsAll = (
  granted: readonly Capability[],
  required: readonly Capability[],
): boolean => required.every((r) => grants(granted, r));

/** The subset of `required` that `granted` does not cover. Empty means allowed. */
export const missingCapabilities = (
  granted: readonly Capability[],
  required: readonly Capability[],
): Capability[] => required.filter((r) => !grants(granted, r));

/**
 * Who asked. Every command execution and every API call carries one, so that
 * "an agent archived 400 messages at 3am" is answerable from the event log.
 */
export const InvokerSchema = z.object({
  kind: z.enum(["user", "keybinding", "palette", "rule", "plugin", "agent", "system"]),
  /** Plugin id, rule id, agent session id. Absent for direct user action. */
  id: z.string().optional(),
  capabilities: CapabilitySetSchema,
});
export type Invoker = z.infer<typeof InvokerSchema>;

/** The user, acting directly. Holds everything; never used for extension code. */
export const USER_INVOKER: Invoker = {
  kind: "user",
  capabilities: [...CORE_CAPABILITIES, "command:invoke:*", "net:fetch:*"],
};
