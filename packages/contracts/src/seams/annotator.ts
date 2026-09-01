import { z } from "zod";
import type { Capability } from "../capabilities.js";
import type { AnnotationDraft } from "../model/annotation.js";
import type { Message } from "../model/message.js";
import type { Thread } from "../model/thread.js";
import type { Cancellable } from "../primitives.js";
import type { LLMProvider } from "./llm.js";

/**
 * SEAM 3 — Annotator.
 *
 * A pure-ish function from a message (or thread) to metadata. Triage and
 * summarisation ship first; anything that turns mail into structured data is
 * the same shape.
 *
 * ## Why `requires` exists
 *
 * It declares the annotator's data appetite up front, so the UI can say
 * "this annotator reads message bodies and sends them to a remote model"
 * *before* it runs, not after. An annotator receives only what it declared.
 *
 * ## Determinism
 *
 * `version` must be bumped whenever output for the same input would change.
 * The core uses (producer, version, inputHash) to decide what to recompute,
 * so a silent behaviour change leaves stale annotations behind.
 */
export const AnnotatorInputFieldSchema = z.enum([
  "headers",
  "text-body",
  "html-body",
  "attachment-metadata",
  "thread-context",
]);
export type AnnotatorInputField = z.infer<typeof AnnotatorInputFieldSchema>;

export interface AnnotatorInput {
  readonly message: Message;
  /** Present only if the annotator declared `text-body`. */
  readonly textBody?: string;
  /** Present only if the annotator declared `html-body`. */
  readonly htmlBody?: string;
  /** Present only if the annotator declared `thread-context`. */
  readonly thread?: Thread;
  readonly attachments?: readonly { filename: string; contentType: string; size: number }[];
}

export interface AnnotatorContext extends Cancellable {
  /** Absent when the user has configured no model. Annotators must cope. */
  readonly llm?: LLMProvider;
  readonly log: (message: string, detail?: Record<string, string | number>) => void;
}

export interface Annotator {
  readonly id: string;
  readonly version: number;
  readonly namespace: string;
  readonly displayName: string;
  readonly requires: readonly AnnotatorInputField[];
  readonly capabilities: readonly Capability[];
  /** True when the annotator needs a configured `LLMProvider` to do anything. */
  readonly needsModel: boolean;
  run(input: AnnotatorInput, ctx: AnnotatorContext): Promise<readonly AnnotationDraft[]>;
}
