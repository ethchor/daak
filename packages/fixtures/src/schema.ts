import { z } from "zod";

/**
 * The shape of an `expected/<id>.json` file.
 *
 * An expectation is deliberately a set of ASSERTIONS, not a full serialised
 * parse tree. A full tree would couple the corpus to one parser's internal
 * representation and would have to be regenerated every time that changed —
 * at which point it stops being a regression suite and becomes a snapshot of
 * whatever the code did last Tuesday.
 *
 * Assert what must be true. Leave the rest to the implementation.
 */
export const ExpectedAddressSchema = z.object({
  name: z.string().optional(),
  address: z.string(),
});

export const FixtureCategorySchema = z.enum([
  "baseline",
  "multipart",
  "nested",
  "attachment",
  "inline-image",
  "content-id",
  "base64",
  "quoted-printable",
  "8bit",
  "charset",
  "rfc2047",
  "headers",
  "folding",
  "address-quoting",
  "address-parsing",
  "threading",
  "dedup",
  "calendar",
  "smime",
  "list-mail",
  "malformed",
  "recovery",
  "dates",
  "edge-case",
  "byte-preservation",
  "performance",
]);
export type FixtureCategory = z.infer<typeof FixtureCategorySchema>;

export const FixtureExpectationSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  categories: z.array(FixtureCategorySchema).min(1),
  /** Where the message came from. Public-archive fixtures record their origin. */
  source: z.enum(["synthetic", "public-archive"]).default("synthetic"),
  sourceUrl: z.string().optional(),
  /** Byte length of the .eml. Guards against an editor silently rewriting it. */
  size: z.number().int().positive(),

  headers: z.object({
    subject: z.string().optional(),
    from: z.array(ExpectedAddressSchema).optional(),
    to: z.array(ExpectedAddressSchema).optional(),
    cc: z.array(ExpectedAddressSchema).optional(),
    messageId: z.array(z.string()).optional(),
    inReplyTo: z.array(z.string()).optional(),
    references: z.array(z.string()).optional(),
    listId: z.string().optional(),
    /** ISO 8601 UTC, or null when the Date header is unparseable. */
    date: z.string().nullable().optional(),
  }),

  /** Flattened content types, depth-first, container first. */
  structure: z.array(z.string()).min(1),
  text: z.object({ contains: z.array(z.string()).optional(), equals: z.string().optional() }).optional(),
  html: z.object({ contains: z.array(z.string()).optional() }).optional(),
  attachments: z.array(
    z.object({
      filename: z.string().optional(),
      contentType: z.string(),
      size: z.number().int().nonnegative().optional(),
    }),
  ),
  inlineParts: z
    .array(z.object({ contentId: z.string(), contentType: z.string(), filename: z.string().optional() }))
    .optional(),
  hasAttachment: z.boolean(),
  headerCountAtLeast: z.number().int().positive().optional(),
  /** Cross-fixture threading expectations. */
  thread: z.object({ parentOf: z.string().optional() }).optional(),
  /** Why this message is in the corpus at all. Read this before "fixing" a test. */
  notes: z.string().optional(),
});
export type FixtureExpectation = z.infer<typeof FixtureExpectationSchema>;

export const ManifestSchema = z.object({
  version: z.number().int().positive(),
  description: z.string(),
  fixtures: z.array(z.string()),
});
export type Manifest = z.infer<typeof ManifestSchema>;
