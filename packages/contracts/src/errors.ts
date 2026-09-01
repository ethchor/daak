import { z } from "zod";

/**
 * One error taxonomy, spoken by every layer.
 *
 * The kind answers exactly one question: **what should the caller do?**
 *
 * - `transient`  — retry with backoff. Network blips, 429s, 5xx, disk busy.
 * - `permanent`  — do not retry. Malformed input, unsupported operation, 404.
 * - `auth`       — stop and involve the user. Expired token, revoked grant.
 * - `conflict`   — reconcile, then retry. State string moved, ETag mismatch,
 *                  optimistic write rejected.
 *
 * If you cannot decide which kind an error is, the answer is `transient` only
 * when a retry is genuinely safe. When a request may have succeeded server-side
 * (the ambiguous timeout), the operation is *unknown*, not failed — model that
 * as an `IntentOutcome` of status `unknown`, never as a thrown error.
 */
export const ERROR_KINDS = ["transient", "permanent", "auth", "conflict"] as const;
export const ErrorKindSchema = z.enum(ERROR_KINDS);
export type ErrorKind = z.infer<typeof ErrorKindSchema>;

/**
 * Stable machine-readable codes. Add to this list rather than inventing
 * free-form strings — rules, telemetry and the agent surface match on them.
 */
export const ErrorCodes = {
  // transient
  NETWORK: "net.unreachable",
  TIMEOUT: "net.timeout",
  RATE_LIMITED: "net.rate_limited",
  SERVER_ERROR: "provider.server_error",
  BUSY: "store.busy",

  // permanent
  INVALID_INPUT: "input.invalid",
  NOT_FOUND: "resource.not_found",
  UNSUPPORTED: "provider.unsupported",
  PARSE_FAILED: "mime.parse_failed",
  QUOTA_EXCEEDED: "provider.over_quota",
  CAPABILITY_DENIED: "capability.denied",
  INTEGRITY: "blob.integrity_failed",

  // auth
  UNAUTHENTICATED: "auth.unauthenticated",
  TOKEN_EXPIRED: "auth.token_expired",
  FORBIDDEN: "auth.forbidden",

  // conflict
  STATE_MISMATCH: "sync.state_mismatch",
  CURSOR_INVALID: "sync.cursor_invalid",
  CONCURRENT_WRITE: "store.concurrent_write",
} as const;
export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export interface DaakErrorInit {
  readonly kind: ErrorKind;
  readonly code: string;
  readonly message: string;
  /**
   * Structured detail for logs and the UI.
   *
   * MUST NOT contain message bodies, header values, credentials or tokens.
   * Errors are logged, shipped to plugins, and shown to agents; treat this
   * field as public.
   */
  readonly context?: Record<string, string | number | boolean | null> | undefined;
  /** Honour this before retrying a `transient` error. */
  readonly retryAfterMs?: number | undefined;
  readonly cause?: unknown;
}

export class DaakError extends Error {
  override readonly name = "DaakError";
  readonly kind: ErrorKind;
  readonly code: string;
  readonly context: Record<string, string | number | boolean | null> | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(init: DaakErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.kind = init.kind;
    this.code = init.code;
    this.context = init.context;
    this.retryAfterMs = init.retryAfterMs;
  }

  static transient(code: string, message: string, extra?: Partial<DaakErrorInit>): DaakError {
    return new DaakError({ ...extra, kind: "transient", code, message });
  }
  static permanent(code: string, message: string, extra?: Partial<DaakErrorInit>): DaakError {
    return new DaakError({ ...extra, kind: "permanent", code, message });
  }
  static auth(code: string, message: string, extra?: Partial<DaakErrorInit>): DaakError {
    return new DaakError({ ...extra, kind: "auth", code, message });
  }
  static conflict(code: string, message: string, extra?: Partial<DaakErrorInit>): DaakError {
    return new DaakError({ ...extra, kind: "conflict", code, message });
  }

  /** Wire form. Crosses the plugin, MCP and worker boundaries. */
  toJSON(): SerializedDaakError {
    return {
      kind: this.kind,
      code: this.code,
      message: this.message,
      ...(this.context === undefined ? {} : { context: this.context }),
      ...(this.retryAfterMs === undefined ? {} : { retryAfterMs: this.retryAfterMs }),
    };
  }
}

export const SerializedDaakErrorSchema = z.object({
  kind: ErrorKindSchema,
  code: z.string().min(1),
  message: z.string(),
  context: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .optional(),
  retryAfterMs: z.number().int().nonnegative().optional(),
});
export type SerializedDaakError = z.infer<typeof SerializedDaakErrorSchema>;

export const isDaakError = (value: unknown): value is DaakError => value instanceof DaakError;

/** Only `transient` and `conflict` are worth another attempt, and only after work. */
export const isRetryable = (error: unknown): boolean =>
  isDaakError(error) && (error.kind === "transient" || error.kind === "conflict");

/**
 * Normalise anything thrown into the taxonomy.
 *
 * Unknown throws become `permanent`: an error nobody classified is not one we
 * should hammer a server with. Classify it properly at the boundary that knows.
 */
export const toDaakError = (value: unknown): DaakError => {
  if (isDaakError(value)) return value;
  if (value instanceof Error) {
    const isAbort = value.name === "AbortError";
    return new DaakError({
      kind: isAbort ? "transient" : "permanent",
      code: isAbort ? ErrorCodes.TIMEOUT : "unknown.unclassified",
      message: value.message,
      cause: value,
    });
  }
  return new DaakError({
    kind: "permanent",
    code: "unknown.unclassified",
    message: typeof value === "string" ? value : "Unknown error",
    cause: value,
  });
};

export const fromSerialized = (value: SerializedDaakError): DaakError =>
  new DaakError({
    kind: value.kind,
    code: value.code,
    message: value.message,
    context: value.context,
    retryAfterMs: value.retryAfterMs,
  });
