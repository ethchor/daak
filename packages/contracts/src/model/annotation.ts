import { z } from "zod";
import { AccountIdSchema, AnnotationIdSchema, MessageIdSchema, ThreadIdSchema } from "../ids.js";
import { InstantSchema, JsonValueSchema } from "../primitives.js";

/**
 * Annotations are the only writable surface outside the core.
 *
 * They are versioned and disposable by design: deleting every annotation must
 * cost the user nothing but recomputation. Anything that cannot survive being
 * dropped does not belong here.
 */
export const AnnotationSubjectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("message"), id: MessageIdSchema }),
  z.object({ kind: z.literal("thread"), id: ThreadIdSchema }),
]);
export type AnnotationSubject = z.infer<typeof AnnotationSubjectSchema>;

export const AnnotationSchema = z.object({
  id: AnnotationIdSchema,
  accountId: AccountIdSchema,
  subject: AnnotationSubjectSchema,

  /** Producer's namespace. A producer may only write inside its own. */
  namespace: z.string().min(1).max(64),
  key: z.string().min(1).max(64),
  value: JsonValueSchema,

  /** Which annotator produced this, and at which version. */
  producer: z.string().min(1),
  producerVersion: z.number().int().nonnegative(),

  /**
   * Digest of the exact input the producer saw. When the input changes, the
   * annotation is stale and can be recomputed without guessing.
   */
  inputHash: z.string().optional(),
  /** 0..1 where the producer can express one. Absent means "not applicable". */
  confidence: z.number().min(0).max(1).optional(),

  createdAt: InstantSchema,
  expiresAt: InstantSchema.optional(),
});
export type Annotation = z.infer<typeof AnnotationSchema>;

/** What an annotator returns. The core assigns the id and timestamps. */
export const AnnotationDraftSchema = AnnotationSchema.omit({
  id: true,
  accountId: true,
  createdAt: true,
  producer: true,
  producerVersion: true,
});
export type AnnotationDraft = z.infer<typeof AnnotationDraftSchema>;
