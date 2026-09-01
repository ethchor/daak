import type { EmailAddress, Instant } from "@daak/contracts";
import { type Address, addressParser, decodeWords } from "postal-mime";
import type { ParseWarning } from "./types.js";

/** RFC 2047 decoding for a single header value. Re-exported for callers. */
export const decodeHeader = (value: string): string => decodeWords(value);

/**
 * Flatten addresses, groups included.
 *
 * `Team: alice@example.org, bob@example.org;` is one RFC 5322 group holding two
 * mailboxes. A parser that returns the group as a single nameless entry loses
 * alice and bob, and a reply-all that quietly drops two recipients is the kind
 * of bug users never forgive.
 */
export const flattenAddresses = (input: Address | Address[] | undefined): EmailAddress[] => {
  if (input === undefined) return [];
  const list = Array.isArray(input) ? input : [input];
  const out: EmailAddress[] = [];
  for (const entry of list) {
    if (entry.group !== undefined) {
      for (const member of entry.group) {
        out.push({ name: member.name ?? "", address: member.address ?? "" });
      }
      // An empty group (`undisclosed-recipients:;`) contributes no recipients.
      // That is correct, not a parse failure.
      continue;
    }
    out.push({ name: entry.name ?? "", address: entry.address ?? "" });
  }
  return out;
};

/** Parse an address header string directly. Used where postal-mime gives us raw text. */
export const parseAddressHeader = (raw: string | undefined): EmailAddress[] =>
  raw === undefined || raw.trim() === "" ? [] : flattenAddresses(addressParser(raw));

const ANGLE = /^<|>$/g;

/**
 * `Message-ID`, `In-Reply-To` and `References` all hold angle-bracketed ids.
 * Stored without the brackets so threading compares like with like, and split
 * on whitespace because `References` is a list and senders are inconsistent
 * about commas.
 */
export const parseMessageIds = (raw: string | undefined): string[] => {
  if (raw === undefined) return [];
  const found = raw.match(/<[^<>]*>/g);
  if (found !== null) {
    return found.map((id) => id.replace(ANGLE, "").trim()).filter((id) => id !== "");
  }
  // No brackets at all. Broken, but common enough that discarding the value
  // would break threading for whole mail clients.
  return raw
    .split(/[\s,]+/)
    .map((id) => id.trim())
    .filter((id) => id !== "");
};

/**
 * `List-Id: Developer discussion <devs.lists.example.org>` — the id is what is
 * inside the brackets. Storing the whole header value makes every list look
 * distinct from itself.
 */
export const parseListId = (raw: string | undefined): string | undefined => {
  if (raw === undefined || raw.trim() === "") return undefined;
  const bracketed = /<([^<>]+)>/.exec(raw);
  return (bracketed?.[1] ?? raw).trim() || undefined;
};

/**
 * A `Date` header, when it is a real date.
 *
 * Returns undefined for anything unparseable and for dates outside a sane
 * range. Never falls back to the current time: a message that claims to be from
 * 1970 or 2087 sorts to an end of the mailbox and is visibly wrong, but one
 * silently stamped "now" jumps to the top and looks correct.
 */
const EARLIEST = Date.UTC(1971, 0, 1);

export const parseDate = (
  raw: string | undefined,
  warnings: ParseWarning[],
): Instant | undefined => {
  if (raw === undefined || raw.trim() === "") {
    warnings.push({ code: "date.missing" });
    return undefined;
  }
  const parsed = new Date(raw);
  const time = parsed.getTime();
  if (Number.isNaN(time)) {
    warnings.push({ code: "date.unparseable" });
    return undefined;
  }
  const latest = Date.now() + 365 * 24 * 60 * 60 * 1000;
  if (time < EARLIEST || time > latest) {
    warnings.push({ code: "date.unparseable", detail: "outside plausible range" });
    return undefined;
  }
  return parsed.toISOString() as Instant;
};
