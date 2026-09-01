import { z } from "zod";

/**
 * Shared value types. Deliberately small: anything that appears in more than
 * one persisted shape lives here so there is exactly one definition of it.
 */

/**
 * An instant in time, serialised as an RFC 3339 / ISO 8601 string in UTC.
 *
 * Stored as text rather than epoch millis because the store is meant to be
 * readable with `sqlite3` and a human eye. Comparisons are lexicographic,
 * which is correct for this format when normalised to UTC.
 */
export const InstantSchema = z.iso.datetime({ offset: false });
export type Instant = z.infer<typeof InstantSchema>;

export const nowInstant = (): Instant => new Date().toISOString() as Instant;
export const toInstant = (value: Date | number | string): Instant =>
  InstantSchema.parse(new Date(value).toISOString());

/** JSON, as actually persisted. Annotation values and event payloads use it. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

/**
 * An address as it appeared in a header.
 *
 * Deliberately NOT validated as a well-formed email address. Real mailboxes
 * contain addresses that no RFC would bless, and a client that refuses to
 * display them is worse than one that shows them faithfully. Validation
 * belongs at compose time, not at parse time.
 */
export const EmailAddressSchema = z.object({
  /** Display name, already RFC 2047-decoded. Empty when the header had none. */
  name: z.string().default(""),
  /** addr-spec as it appeared, unfolded and unquoted. May be malformed. */
  address: z.string(),
});
export type EmailAddress = z.infer<typeof EmailAddressSchema>;

/** A content-type with its parameters, lowercased type/subtype. */
export const ContentTypeSchema = z.object({
  type: z.string(),
  subtype: z.string(),
  parameters: z.record(z.string(), z.string()).default({}),
});
export type ContentType = z.infer<typeof ContentTypeSchema>;

/** Byte size. Separate alias so budgets and quotas read clearly. */
export const ByteSizeSchema = z.number().int().nonnegative();

/** Cancellation is universal at every seam; every long call takes one. */
export type Cancellable = { readonly signal?: AbortSignal | undefined };

/** Returned by every subscribe-shaped API. Idempotent. */
export type Unsubscribe = () => void;

/** Cursor-paged reads share this shape across providers and the store. */
export interface Page<T> {
  readonly items: readonly T[];
  /** Opaque. Pass back verbatim; never parse it outside the producer. */
  readonly cursor: string | null;
  readonly hasMore: boolean;
}
