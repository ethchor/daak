import { DaakError, ErrorCodes } from "@daak/contracts";
import PostalMime, { type Email, type Attachment as RawAttachment } from "postal-mime";
import {
  decodeHeader,
  flattenAddresses,
  parseAddressHeader,
  parseDate,
  parseListId,
  parseMessageIds,
} from "./headers.js";
import { buildPreview } from "./preview.js";
import { flattenStructure, scanStructure } from "./structure.js";
import type {
  Attachment,
  Envelope,
  InlinePart,
  ParsedMessage,
  ParseOptions,
  ParseWarning,
} from "./types.js";

/**
 * Parts that are MIME machinery, not something a user attached.
 *
 * A paperclip icon on every signed message and every newsletter with a logo is
 * a small bug that erodes trust in the whole list view.
 */
const PROTOCOL_CONTENT_TYPES = new Set([
  "application/pkcs7-signature",
  "application/x-pkcs7-signature",
  "application/pgp-signature",
  "application/pgp-keys",
]);

const EXTENSION_BY_TYPE: Record<string, string> = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "text/plain": "txt",
  "text/calendar": "ics",
  "message/rfc822": "eml",
};

const toBytes = (content: RawAttachment["content"]): Uint8Array => {
  if (content instanceof Uint8Array) return content;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  return new TextEncoder().encode(String(content));
};

const stripAngles = (value: string | undefined): string | undefined =>
  value === undefined ? undefined : value.replace(/^<|>$/g, "").trim() || undefined;

/**
 * Is this part something the user would call an attachment?
 *
 * The rules come from the corpus, and each one exists because a fixture says so:
 *
 * - `related` or an inline part with a Content-ID is referenced from the HTML by
 *   `cid:`. It is rendered, not listed.
 * - A detached signature is protocol.
 * - `text/calendar` carried as an alternative body is the invite itself; a real
 *   `.ics` a user attached has `Content-Disposition: attachment` and stays one.
 */
const classify = (part: RawAttachment): "attachment" | "inline" | "protocol" => {
  if (PROTOCOL_CONTENT_TYPES.has(part.mimeType)) return "protocol";
  if (part.related === true) return "inline";
  if (part.disposition === "inline" && stripAngles(part.contentId) !== undefined) return "inline";
  if (part.mimeType === "text/calendar" && part.disposition !== "attachment") return "protocol";
  return "attachment";
};

/** A stable name for a part the sender never named, so the UI has no blank rows. */
const displayNameFor = (part: RawAttachment, index: number): string => {
  if (part.filename !== null && part.filename !== "") return part.filename;
  const extension = EXTENSION_BY_TYPE[part.mimeType] ?? "bin";
  return `attachment-${index + 1}.${extension}`;
};

const headerValues = (email: Email, key: string): string[] =>
  email.headers.filter((header) => header.key === key).map((header) => header.value);

const firstHeader = (email: Email, key: string): string | undefined => headerValues(email, key)[0];

/**
 * Parse a message.
 *
 * Never mutates the input, and never rewrites it: the bytes handed in stay the
 * canonical form of the message, and everything returned is a projection that
 * can be thrown away and recomputed.
 *
 * Throws only when the input is not a message at all. Malformed mail — an
 * unclosed boundary, a nonsense date, a charset that lies — comes back parsed
 * as far as it could be, with `warnings` saying what went wrong.
 */
export const parseMessage = async (
  raw: Uint8Array,
  options: ParseOptions = {},
): Promise<ParsedMessage> => {
  if (raw.byteLength === 0) {
    throw DaakError.permanent(ErrorCodes.PARSE_FAILED, "empty input is not a message");
  }

  const warnings: ParseWarning[] = [];

  let email: Email;
  try {
    email = await PostalMime.parse(raw, {
      attachmentEncoding: "arraybuffer",
      maxNestingDepth: options.maxDepth ?? 20,
    });
  } catch (error) {
    throw DaakError.permanent(ErrorCodes.PARSE_FAILED, "could not be parsed as a message", {
      cause: error,
    });
  }

  const { root, warnings: structureWarnings } = scanStructure(raw, options.maxDepth ?? 20);
  warnings.push(...structureWarnings);

  const messageIdHeader = headerValues(email, "message-id").flatMap(parseMessageIds);
  if (messageIdHeader.length === 0) warnings.push({ code: "message-id.missing" });

  const envelope: Envelope = {
    subject: email.subject ?? "",
    from: flattenAddresses(email.from),
    to: flattenAddresses(email.to),
    cc: flattenAddresses(email.cc),
    // Bcc survives in a sent copy, and dropping it loses who a message went to.
    bcc: flattenAddresses(email.bcc),
    replyTo: flattenAddresses(email.replyTo),
    messageIdHeader,
    inReplyTo: parseMessageIds(firstHeader(email, "in-reply-to")),
    references: parseMessageIds(firstHeader(email, "references")),
    listId: parseListId(firstHeader(email, "list-id")),
    sentAt: parseDate(firstHeader(email, "date"), warnings),
  };

  const attachments: Attachment[] = [];
  const inlineParts: InlinePart[] = [];

  email.attachments.forEach((part, index) => {
    const content = toBytes(part.content);
    switch (classify(part)) {
      case "attachment":
        attachments.push({
          filename: part.filename === "" ? null : part.filename,
          displayName: displayNameFor(part, index),
          contentType: part.mimeType,
          size: content.byteLength,
          content,
        });
        break;
      case "inline": {
        const contentId = stripAngles(part.contentId);
        inlineParts.push({
          contentId: contentId ?? `part-${index + 1}`,
          contentType: part.mimeType,
          filename: part.filename === "" ? null : part.filename,
          size: content.byteLength,
          content,
        });
        break;
      }
      case "protocol":
        break;
    }
  });

  return {
    envelope,
    structure: flattenStructure(root),
    parts: root,
    text: email.text,
    html: email.html,
    attachments,
    inlineParts,
    hasAttachment: attachments.length > 0,
    preview: buildPreview(email.text, email.html, options.previewLength ?? 512),
    size: raw.byteLength,
    warnings,
  };
};

export { decodeHeader, parseAddressHeader };
