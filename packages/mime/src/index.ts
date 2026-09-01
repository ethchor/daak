/**
 * @daak/mime — RFC 5322/2045 parsing, byte-preserving.
 *
 * A wrapper, not a parser. `postal-mime` does the decoding — charsets, encoded
 * words, transfer encodings, the parts nobody writes correctly first time — and
 * this package owns the policy: what counts as an attachment, how a date that
 * is nonsense is handled, how a group address flattens, and what the part tree
 * looks like.
 *
 * The wrapper is the deliverable. It is what lets the library underneath be
 * replaced without touching anything else, and the corpus is what proves the
 * replacement is safe.
 */

export { flattenAddresses, parseDate, parseListId, parseMessageIds } from "./headers.js";
export { decodeHeader, parseAddressHeader, parseMessage } from "./parse.js";
export { buildPreview } from "./preview.js";
export { flattenStructure, parseContentType, scanStructure } from "./structure.js";
export type {
  Attachment,
  Envelope,
  InlinePart,
  MimePart,
  ParsedMessage,
  ParseOptions,
  ParseWarning,
  ParseWarningCode,
} from "./types.js";
export { PARSE_WARNINGS } from "./types.js";
