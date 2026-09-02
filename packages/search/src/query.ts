import type { Instant } from "@daak/contracts";

/**
 * The query grammar.
 *
 * One rule dominates every decision here: **the parser is total.** Any string
 * produces a query and nothing ever throws. Someone typing `from:` and pausing
 * to think has not made an error, and a search box that turns red while you are
 * still typing is worse than one that shows imperfect results.
 *
 * So an unrecognised field, an unclosed quote, a date that is not a date and a
 * lone `-` all degrade into full-text terms. The worst outcome is a search that
 * finds too much, which the user can see and correct.
 */
export type ClauseKind =
  | "text"
  | "phrase"
  | "from"
  | "to"
  | "subject"
  | "mailbox"
  | "list"
  | "keyword"
  | "attachment"
  | "before"
  | "after";

export interface Clause {
  readonly kind: ClauseKind;
  readonly value: string;
  /** `-from:asha` excludes rather than requires. */
  readonly negated: boolean;
}

export interface Query {
  readonly clauses: readonly Clause[];
  /** Exactly what the user typed. Kept for the UI and for saved searches. */
  readonly raw: string;
}

/** Fields that take a value. Anything else becomes text. */
const FIELDS: Record<string, ClauseKind> = {
  from: "from",
  to: "to",
  cc: "to",
  subject: "subject",
  in: "mailbox",
  mailbox: "mailbox",
  list: "list",
  before: "before",
  after: "after",
  since: "after",
  until: "before",
};

/** `is:` and `has:` take a fixed vocabulary rather than free text. */
const IS_KEYWORDS: Record<string, { keyword: string; negated: boolean }> = {
  unread: { keyword: "$seen", negated: true },
  read: { keyword: "$seen", negated: false },
  seen: { keyword: "$seen", negated: false },
  unseen: { keyword: "$seen", negated: true },
  flagged: { keyword: "$flagged", negated: false },
  starred: { keyword: "$flagged", negated: false },
  draft: { keyword: "$draft", negated: false },
  answered: { keyword: "$answered", negated: false },
};

/**
 * A date, as a person would type it.
 *
 * Accepts `2026-08-31`, `2026-08` and `2026`. Anything else is not a date and
 * becomes a text term — guessing at `last tuesday` belongs in the natural
 * language layer, which is a different package and is allowed to be wrong.
 */
export const parseQueryDate = (value: string): Instant | undefined => {
  const match = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(value.trim());
  if (match === null) return undefined;
  const [, year, month = "01", day = "01"] = match;
  const date = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString() as Instant;
};

interface Token {
  readonly value: string;
  readonly quoted: boolean;
}

/**
 * Split on whitespace, keeping quoted runs together.
 *
 * An unclosed quote runs to the end of the input rather than failing — it is
 * what someone halfway through typing a phrase has.
 */
const tokenize = (input: string): Token[] => {
  const tokens: Token[] = [];
  let current = "";
  let quoted = false;
  let inQuotes = false;

  const push = () => {
    if (current !== "") tokens.push({ value: current, quoted });
    current = "";
    quoted = false;
  };

  for (const character of input) {
    if (character === '"') {
      if (inQuotes) {
        // A quoted run stays a phrase even when empty of content.
        tokens.push({ value: current, quoted: true });
        current = "";
        inQuotes = false;
      } else {
        push();
        inQuotes = true;
        quoted = true;
      }
      continue;
    }
    if (!inQuotes && /\s/.test(character)) {
      push();
      continue;
    }
    current += character;
  }
  if (inQuotes) tokens.push({ value: current, quoted: true });
  else push();

  return tokens.filter((token) => token.value !== "" || token.quoted);
};

export const parseQuery = (input: string): Query => {
  const clauses: Clause[] = [];

  for (const token of tokenize(input)) {
    let text = token.value;
    let negated = false;

    // A lone `-` is a term, not a negation of nothing.
    if (!token.quoted && text.startsWith("-") && text.length > 1) {
      negated = true;
      text = text.slice(1);
    }

    if (token.quoted) {
      clauses.push({ kind: "phrase", value: text, negated });
      continue;
    }

    const separator = text.indexOf(":");
    if (separator <= 0 || separator === text.length - 1) {
      // No field, or a field with nothing after it. Either way it is text —
      // `from:` on its own is someone mid-thought, not a syntax error.
      clauses.push({ kind: "text", value: text, negated });
      continue;
    }

    const name = text.slice(0, separator).toLowerCase();
    const value = text.slice(separator + 1);

    if (name === "is") {
      const known = IS_KEYWORDS[value.toLowerCase()];
      if (known === undefined) {
        clauses.push({ kind: "text", value: text, negated });
        continue;
      }
      clauses.push({
        kind: "keyword",
        value: known.keyword,
        // `-is:unread` is `is:read`. Two negations cancel.
        negated: known.negated !== negated,
      });
      continue;
    }

    if (name === "has") {
      if (value.toLowerCase() === "attachment" || value.toLowerCase() === "attachments") {
        clauses.push({ kind: "attachment", value: "true", negated });
      } else {
        clauses.push({ kind: "text", value: text, negated });
      }
      continue;
    }

    const kind = FIELDS[name];
    if (kind === undefined) {
      // An unknown field is not an error. `weird:thing` is a search for
      // "weird:thing", which is what someone pasting a log line wants.
      clauses.push({ kind: "text", value: text, negated });
      continue;
    }

    if (kind === "before" || kind === "after") {
      const instant = parseQueryDate(value);
      if (instant === undefined) {
        clauses.push({ kind: "text", value: text, negated });
        continue;
      }
      clauses.push({ kind, value: instant, negated });
      continue;
    }

    clauses.push({ kind, value, negated });
  }

  return { clauses, raw: input };
};

/** The free-text half of a query — what actually goes to FTS5. */
export const textClauses = (query: Query): Clause[] =>
  query.clauses.filter((clause) => clause.kind === "text" || clause.kind === "phrase");

/** The structured half — what becomes SQL predicates. */
export const filterClauses = (query: Query): Clause[] =>
  query.clauses.filter((clause) => clause.kind !== "text" && clause.kind !== "phrase");
