/**
 * @daak/search — the local index and the query grammar.
 *
 * No AI anywhere in this package. Natural-language search is a separate layer
 * in `@daak/intelligence` that compiles down to this package's `Query`; search
 * itself never calls a model, and works with none configured.
 */

export type { SearchDocument, SearchIndex } from "./index-writer.js";
export { createSearchIndex } from "./index-writer.js";
export type { Clause, ClauseKind, Query } from "./query.js";
export { filterClauses, parseQuery, parseQueryDate, textClauses } from "./query.js";
export type { Searcher, SearchHit, SearchOptions } from "./search.js";
export { createSearcher } from "./search.js";
