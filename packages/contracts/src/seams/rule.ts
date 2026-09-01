import { z } from "zod";
import { CommandIdSchema, RuleIdSchema } from "../ids.js";
import { JsonValueSchema } from "../primitives.js";

/**
 * SEAM 7 — Rule.
 *
 * A rule is a serialisable condition plus a list of command invocations.
 * Serialisable matters: rules are stored, shown in a UI, shared between
 * machines, and eventually authored in natural language and compiled into this
 * AST. A rule that is a closure can be none of those things.
 *
 * Conditions are pure and total — no I/O, no network, no clock beyond the
 * message's own timestamps — so evaluating a rule can never fail halfway.
 */
export const RuleFieldSchema = z.enum([
  "from",
  "to",
  "cc",
  "recipients",
  "subject",
  "body",
  "mailbox",
  "keyword",
  "listId",
  "hasAttachment",
  "size",
  "receivedAt",
  "annotation",
]);
export type RuleField = z.infer<typeof RuleFieldSchema>;

export const RuleOperatorSchema = z.enum([
  "contains",
  "equals",
  "startsWith",
  "endsWith",
  "matches",
  "in",
  "gt",
  "lt",
  "exists",
]);
export type RuleOperator = z.infer<typeof RuleOperatorSchema>;

export type RuleCondition =
  | { readonly all: readonly RuleCondition[] }
  | { readonly any: readonly RuleCondition[] }
  | { readonly not: RuleCondition }
  | {
      readonly field: RuleField;
      readonly op: RuleOperator;
      readonly value: z.infer<typeof JsonValueSchema>;
      /** For `field: "annotation"`, which `namespace.key` to look at. */
      readonly path?: string | undefined;
    };

export const RuleConditionSchema: z.ZodType<RuleCondition> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(RuleConditionSchema) }),
    z.object({ any: z.array(RuleConditionSchema) }),
    z.object({ not: RuleConditionSchema }),
    z.object({
      field: RuleFieldSchema,
      op: RuleOperatorSchema,
      value: JsonValueSchema,
      path: z.string().optional(),
    }),
  ]),
);

export const RuleActionSchema = z.object({
  commandId: CommandIdSchema,
  args: JsonValueSchema,
});
export type RuleAction = z.infer<typeof RuleActionSchema>;

export const RuleSchema = z.object({
  id: RuleIdSchema,
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  /** When the rule is evaluated. `manual` rules only run when invoked. */
  trigger: z.enum(["message.observed", "message.annotated", "manual"]),
  condition: RuleConditionSchema,
  actions: z.array(RuleActionSchema).min(1),
  /** Stop evaluating later rules when this one matches. */
  stopOnMatch: z.boolean().default(false),
});
export type Rule = z.infer<typeof RuleSchema>;
