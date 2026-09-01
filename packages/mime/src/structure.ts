import type { MimePart, ParseWarning } from "./types.js";

/**
 * A structure scanner: content types and nesting, nothing else.
 *
 * `postal-mime` decodes bodies, charsets and encoded words — the parts nobody
 * writes correctly first time — but it does not expose the part tree, and the
 * tree is what the corpus asserts on. So this reads Content-Type headers and
 * boundary delimiters and stops there. It decodes nothing, converts no charset
 * and extracts no content, which is what keeps it small enough to be obviously
 * right.
 *
 * Bytes are handled as a 1:1 byte-to-code-unit string. No TextDecoder: every
 * label has an encoding table behind it, and structure is pure ASCII.
 */
const DEFAULT_MAX_DEPTH = 20;

const toBinaryString = (bytes: Uint8Array): string => {
  let out = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return out;
};

/** Split headers from body at the first blank line, CRLF or bare LF. */
const splitHeaders = (text: string): { headers: string; body: string } => {
  const crlf = text.indexOf("\r\n\r\n");
  const lf = text.indexOf("\n\n");
  // Whichever separator comes first wins; a message may use either, and some
  // use both in different places.
  const candidates = [crlf, lf].filter((i) => i >= 0);
  if (candidates.length === 0) return { headers: text, body: "" };
  const at = Math.min(...candidates);
  const width = at === crlf ? 4 : 2;
  return { headers: text.slice(0, at), body: text.slice(at + width) };
};

/** Unfold continuation lines, then pick out one header by name. */
const headerValue = (headers: string, name: string): string | undefined => {
  const unfolded = headers.replace(/\r?\n[ \t]+/g, " ");
  const target = name.toLowerCase();
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon < 1) continue;
    if (line.slice(0, colon).trim().toLowerCase() === target) {
      return line.slice(colon + 1).trim();
    }
  }
  return undefined;
};

interface ContentType {
  contentType: string;
  parameters: Record<string, string>;
}

export const parseContentType = (raw: string | undefined): ContentType => {
  // A missing Content-Type means text/plain; us-ascii (RFC 2045 §5.2).
  if (raw === undefined || raw.trim() === "") {
    return { contentType: "text/plain", parameters: {} };
  }
  const [head = "", ...rest] = raw.split(";");
  const contentType = head.trim().toLowerCase();
  const parameters: Record<string, string> = {};
  for (const chunk of rest) {
    const eq = chunk.indexOf("=");
    if (eq < 1) continue;
    const key = chunk.slice(0, eq).trim().toLowerCase();
    let value = chunk.slice(eq + 1).trim();
    if (value.startsWith('"')) {
      // Quoted boundaries are common and may contain semicolons, which the
      // naive split above will have cut. Recover by re-reading from the source.
      const start = raw.indexOf(value);
      const closing = raw.indexOf('"', start + 1);
      value = closing > start ? raw.slice(start + 1, closing) : value.replace(/^"|"$/g, "");
    }
    if (key !== "") parameters[key] = value;
  }
  return { contentType: contentType === "" ? "text/plain" : contentType, parameters };
};

interface ScanResult {
  readonly root: MimePart;
  readonly warnings: readonly ParseWarning[];
}

export const scanStructure = (bytes: Uint8Array, maxDepth = DEFAULT_MAX_DEPTH): ScanResult => {
  const warnings: ParseWarning[] = [];

  const scan = (text: string, depth: number): MimePart => {
    const { headers, body } = splitHeaders(text);
    const { contentType, parameters } = parseContentType(headerValue(headers, "content-type"));

    if (!contentType.startsWith("multipart/")) {
      return { contentType, parameters, children: [] };
    }
    if (depth >= maxDepth) {
      warnings.push({ code: "structure.depth-exceeded", detail: `depth ${depth}` });
      return { contentType, parameters, children: [] };
    }

    const boundary = parameters["boundary"];
    if (boundary === undefined || boundary === "") {
      // multipart with no boundary: there is no way to find the parts. Report
      // it rather than guessing, and treat the body as opaque.
      warnings.push({ code: "boundary.missing", detail: contentType });
      return { contentType, parameters, children: [] };
    }

    const delimiter = `--${boundary}`;
    const segments: string[] = [];
    let cursor = body.indexOf(delimiter);
    if (cursor < 0) {
      warnings.push({ code: "boundary.missing", detail: contentType });
      return { contentType, parameters, children: [] };
    }

    let closed = false;
    while (cursor >= 0) {
      const afterDelimiter = cursor + delimiter.length;
      if (body.startsWith("--", afterDelimiter)) {
        closed = true;
        break;
      }
      const partStart = body.indexOf("\n", afterDelimiter);
      if (partStart < 0) break;
      const next = body.indexOf(delimiter, partStart);
      // No closing delimiter: the last part runs to end-of-message. Truncating
      // it here would silently drop an attachment, which is worse than the
      // malformed input we were handed.
      segments.push(body.slice(partStart + 1, next < 0 ? body.length : next));
      cursor = next;
    }
    if (!closed) {
      warnings.push({ code: "boundary.unclosed", detail: contentType });
    }

    return {
      contentType,
      parameters,
      // message/rfc822 is deliberately not descended into: its headers belong to
      // the attached message, and treating them as this message's own is how
      // threading gets corrupted by a forward.
      children: segments.map((segment) => scan(segment, depth + 1)),
    };
  };

  return { root: scan(toBinaryString(bytes), 0), warnings };
};

/** Depth-first, container before children — the order the corpus asserts. */
export const flattenStructure = (part: MimePart): string[] => [
  part.contentType,
  ...part.children.flatMap(flattenStructure),
];
