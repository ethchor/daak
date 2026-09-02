import type { AccountId, Instant, MessageId, ThreadId } from "@daak/contracts";
import type { SqlValue, Store } from "@daak/store";
import { type Clause, filterClauses, parseQuery, type Query, textClauses } from "./query.js";

export interface SearchHit {
  readonly messageId: MessageId;
  readonly threadId: ThreadId;
  readonly receivedAt: Instant;
  readonly subject: string;
  /** Lower is better, as FTS5 reports it. Zero when there was no text to rank. */
  readonly score: number;
  /** A highlighted excerpt. Never the whole body. */
  readonly snippet: string;
}

export interface SearchOptions {
  readonly accountId: AccountId;
  readonly limit?: number;
  /**
   * Reference time for the recency boost. Injected so a test's expectations do
   * not depend on when it ran.
   */
  readonly now?: Instant;
  /**
   * How strongly to prefer recent mail, in bm25 units.
   *
   * Mail is not documents: a mediocre match from this morning usually beats a
   * perfect one from 2019. Zero turns the boost off entirely.
   */
  readonly recencyWeight?: number;
}

/**
 * FTS5 escaping.
 *
 * Everything is wrapped in double quotes and internal quotes are doubled, which
 * makes every term a literal. Without it a user typing `OR` or `NEAR(` or a
 * bare `*` gets a syntax error from SQLite — and a search box that errors on
 * ordinary words is broken.
 */
const asFtsLiteral = (term: string): string => `"${term.replace(/"/g, '""')}"`;

/** Terms that would match nothing useful, dropped rather than sent to FTS5. */
const isUsefulTerm = (term: string): boolean => term.trim().length > 0;

const buildMatchExpression = (clauses: readonly Clause[]): string | null => {
  const required: string[] = [];
  const excluded: string[] = [];

  for (const clause of clauses) {
    if (!isUsefulTerm(clause.value)) continue;
    const literal = asFtsLiteral(clause.value.trim());
    if (clause.negated) excluded.push(literal);
    else required.push(literal);
  }

  if (required.length === 0 && excluded.length === 0) return null;
  // With only exclusions there is nothing to match against, so match everything
  // and let the NOT do the work.
  const positive = required.length > 0 ? required.join(" AND ") : null;
  const negative = excluded.length > 0 ? excluded.join(" OR ") : null;

  if (positive !== null && negative !== null) return `(${positive}) NOT (${negative})`;
  if (positive !== null) return positive;
  return null;
};

interface Predicate {
  readonly sql: string;
  readonly params: SqlValue[];
}

/** Structured clauses into SQL over the store's own tables. */
const buildPredicates = (clauses: readonly Clause[]): Predicate[] => {
  const predicates: Predicate[] = [];

  for (const clause of clauses) {
    const negate = (sql: string) => (clause.negated ? `not (${sql})` : sql);

    switch (clause.kind) {
      case "from":
        // The address JSON is searched as text. Crude, and it is the right
        // trade: an address index would double write cost for a filter people
        // combine with a text term anyway.
        predicates.push({
          sql: negate("lower(m.addr_from) like ?"),
          params: [`%${clause.value.toLowerCase()}%`],
        });
        break;
      case "to":
        predicates.push({
          sql: negate("(lower(m.addr_to) like ? or lower(m.addr_cc) like ?)"),
          params: [`%${clause.value.toLowerCase()}%`, `%${clause.value.toLowerCase()}%`],
        });
        break;
      case "subject":
        predicates.push({
          sql: negate("lower(m.subject) like ?"),
          params: [`%${clause.value.toLowerCase()}%`],
        });
        break;
      case "list":
        predicates.push({
          sql: negate("lower(coalesce(m.list_id, '')) like ?"),
          params: [`%${clause.value.toLowerCase()}%`],
        });
        break;
      case "mailbox":
        // Match a mailbox by name or by id, because `in:` is typed by a human
        // who knows the name and pasted by a rule that knows the id.
        predicates.push({
          sql: negate(
            `exists (
               select 1 from message_mailboxes mm
               join mailboxes mb on mb.id = mm.mailbox_id
               where mm.message_id = m.id and (lower(mb.name) = ? or mb.id = ?)
             )`,
          ),
          params: [clause.value.toLowerCase(), clause.value],
        });
        break;
      case "keyword":
        predicates.push({
          sql: negate(
            "exists (select 1 from message_keywords mk where mk.message_id = m.id and mk.keyword = ?)",
          ),
          params: [clause.value],
        });
        break;
      case "attachment":
        predicates.push({ sql: negate("m.has_attachment = 1"), params: [] });
        break;
      case "before":
        predicates.push({ sql: negate("m.received_at < ?"), params: [clause.value] });
        break;
      case "after":
        predicates.push({ sql: negate("m.received_at >= ?"), params: [clause.value] });
        break;
      default:
        break;
    }
  }

  return predicates;
};

export interface Searcher {
  search(query: string | Query, options: SearchOptions): SearchHit[];
}

export const createSearcher = (store: Store): Searcher => {
  const { driver } = store;

  return {
    search(input, options) {
      const query = typeof input === "string" ? parseQuery(input) : input;
      const match = buildMatchExpression(textClauses(query));
      const predicates = buildPredicates(filterClauses(query));
      const limit = options.limit ?? 50;
      const recencyWeight = options.recencyWeight ?? 3;
      const now = options.now ?? (new Date().toISOString() as Instant);

      const where = ["m.account_id = ?"];
      const params: SqlValue[] = [options.accountId];

      for (const predicate of predicates) {
        where.push(predicate.sql);
        params.push(...predicate.params);
      }

      // Two shapes, because a query with no text has nothing to rank and must
      // not touch FTS5 at all. `in:inbox is:unread` is a perfectly good search
      // and joining an empty match expression would return nothing.
      if (match === null) {
        const sql = `
          select m.id, m.thread_id, m.received_at, m.subject, m.preview
          from messages m
          where ${where.join(" and ")}
          order by m.received_at desc, m.id desc
          limit ?
        `;
        params.push(limit);
        return driver
          .prepare(sql)
          .all(...params)
          .map((row) => ({
            messageId: String(row.id) as MessageId,
            threadId: String(row.thread_id) as ThreadId,
            receivedAt: String(row.received_at) as Instant,
            subject: String(row.subject),
            score: 0,
            snippet: String(row.preview ?? ""),
          }));
      }

      /**
       * Ranking.
       *
       * bm25() is negative and more negative is better. The recency boost is
       * subtracted, so recent mail sorts earlier — and it decays rather than
       * stepping, because a cliff at "30 days" would reorder someone's results
       * overnight for no reason they could see.
       */
      const sql = `
        select m.id, m.thread_id, m.received_at, m.subject,
               bm25(message_fts) as text_rank,
               snippet(message_fts, 5, '', '', '…', 12) as excerpt,
               bm25(message_fts)
                 - (? / (1.0 + max(julianday(?) - julianday(m.received_at), 0.0) / 30.0)) as score
        from message_fts
        join messages m on m.id = message_fts.message_id
        where message_fts match ?
          and ${where.join(" and ")}
        order by score asc
        limit ?
      `;

      // Parameter order follows the SQL text, not the logical grouping.
      const ordered: SqlValue[] = [recencyWeight, now, match, ...params, limit];

      return driver
        .prepare(sql)
        .all(...ordered)
        .map((row) => ({
          messageId: String(row.id) as MessageId,
          threadId: String(row.thread_id) as ThreadId,
          receivedAt: String(row.received_at) as Instant,
          subject: String(row.subject),
          score: typeof row.score === "number" ? row.score : 0,
          snippet: String(row.excerpt ?? ""),
        }));
    },
  };
};
