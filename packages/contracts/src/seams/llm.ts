import { z } from "zod";
import type { Cancellable } from "../primitives.js";

/**
 * SEAM 2 — Model.
 *
 * "Bring your own intelligence." Ships with an Anthropic provider and an Ollama
 * provider; both are optional, and Daak is fully usable with neither
 * configured. No default sends mail anywhere.
 *
 * `residency` is not decoration. The UI shows it before a user points an
 * annotator at their mailbox, and rules can refuse to run remote models.
 */
export const ModelResidencySchema = z.enum(["local", "remote"]);
export type ModelResidency = z.infer<typeof ModelResidencySchema>;

export const LLMModelSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  supportsStructuredOutput: z.boolean().default(false),
  supportsStreaming: z.boolean().default(false),
});
export type LLMModel = z.infer<typeof LLMModelSchema>;

export interface CompletionMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface CompletionRequest extends Cancellable {
  readonly model: string;
  readonly system?: string;
  readonly messages: readonly CompletionMessage[];
  readonly maxOutputTokens: number;
  readonly temperature?: number;
  /**
   * Ask for JSON matching this schema. Providers that cannot enforce it must
   * still validate before returning — a caller may assume the shape holds.
   */
  readonly responseSchema?: z.ZodType<unknown>;
}

export interface CompletionUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface CompletionResponse {
  readonly text: string;
  readonly model: string;
  readonly usage: CompletionUsage;
  readonly finishReason: "stop" | "length" | "refusal" | "error";
}

export interface LLMProvider {
  readonly id: string;
  readonly residency: ModelResidency;
  /** Reachability + credential check. Must not consume tokens. */
  health(options?: Cancellable): Promise<{ ok: boolean; detail?: string }>;
  models(options?: Cancellable): Promise<readonly LLMModel[]>;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
  stream?(request: CompletionRequest): AsyncIterable<string>;
}
