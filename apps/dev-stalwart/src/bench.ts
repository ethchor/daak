import type { AccountId, Instant, MailboxId } from "@daak/contracts";
import { createSearcher, createSearchIndex } from "@daak/search";
import { createNodeDriver, openStore, type Store } from "@daak/store";
import type { Population } from "./population.js";
import { realProjectors } from "./seed-store.js";

/**
 * The performance budgets, measured.
 *
 * `ARCHITECTURE.md` lists five interaction budgets and says they are enforced
 * against a seeded 500k mailbox. Until this file existed they were enforced
 * against nothing: no mailbox that large had ever been built, so every number
 * in that table was a budget in the sense of an intention.
 *
 * Two honesty notes belong with any number this produces.
 *
 * The budgets are *interaction* budgets — keystroke to updated list — and there
 * is no interface yet. What is measured here is the query underneath, which is
 * a floor, not the whole cost. Rendering, IPC and the framework's own work all
 * come out of the same 50ms and none of it is counted.
 *
 * And these run on whatever machine invoked them. A number from a laptop on
 * battery and a number from a CI runner are not comparable, so the report
 * prints the host it ran on and nothing here asserts a threshold. Wiring this
 * into CI as a gate is week 3, and it needs a runner whose variance is known.
 */
export interface BenchCase {
  readonly name: string;
  /** From the table in `ARCHITECTURE.md`. */
  readonly budgetMs: number;
  /** What the interaction actually costs beyond this, and is not measured. */
  readonly excludes: string;
  run(iteration: number): void;
}

export interface BenchResult {
  readonly name: string;
  readonly budgetMs: number;
  readonly excludes: string;
  readonly samples: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  readonly withinBudget: boolean;
}

const percentile = (sorted: readonly number[], fraction: number): number => {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[index] ?? 0;
};

export const runCase = (benchCase: BenchCase, iterations: number): BenchResult => {
  // Warm up. The first call of anything pays for a query plan, a page cache
  // and a JIT tier-up, none of which a user pays on every keystroke.
  for (let i = 0; i < Math.min(5, iterations); i += 1) benchCase.run(i);

  const timings: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const started = performance.now();
    benchCase.run(i);
    timings.push(performance.now() - started);
  }
  timings.sort((a, b) => a - b);

  const p95 = percentile(timings, 0.95);
  return {
    name: benchCase.name,
    budgetMs: benchCase.budgetMs,
    excludes: benchCase.excludes,
    samples: timings.length,
    p50: percentile(timings, 0.5),
    p95,
    max: timings[timings.length - 1] ?? 0,
    // p95 rather than the mean: a budget the median meets and one keystroke in
    // twenty misses is a budget that feels missed.
    withinBudget: p95 <= benchCase.budgetMs,
  };
};

export interface BenchOptions {
  readonly store: Store;
  readonly accountId: AccountId;
  readonly mailboxes: readonly MailboxId[];
  /** Reference time for the recency boost — the corpus's own end, never the clock. */
  readonly now: Instant;
  readonly iterations?: number | undefined;
  /** Set when the store is file-backed, so cold start can be measured. */
  readonly location?: string | undefined;
}

/** Terms drawn from the vocabulary's common core, so they actually match. */
const SEARCH_TERMS = [
  "meeting",
  "invoice",
  "release",
  "budget",
  "deadline",
  "customer",
  "migration",
  "attachment",
];

export const benchmark = (options: BenchOptions): BenchResult[] => {
  const { store, accountId, now } = options;
  const searcher = createSearcher(store);
  const iterations = options.iterations ?? 50;

  const threadIds = store
    .queryMessages({ accountId, limit: 200 })
    .map((message) => message.threadId);

  /**
   * Is there anything to search?
   *
   * A seed run with `--no-index` leaves the full-text table empty, and an
   * empty FTS table answers every query instantly with nothing. That would
   * print two rows comfortably inside budget which mean the opposite of what
   * they appear to mean, so the text cases are dropped instead of flattered.
   */
  const indexed = createSearchIndex(store).count(accountId) > 0;

  const cases: BenchCase[] = [
    {
      name: "Mailbox switch",
      budgetMs: 50,
      excludes: "rendering the list",
      run(i) {
        const mailboxId = options.mailboxes[i % options.mailboxes.length];
        store.queryMessages({ accountId, mailboxId, limit: 50 });
      },
    },
    {
      name: "Keystroke → list update",
      budgetMs: 50,
      excludes: "rendering the list, and debounce",
      run(i) {
        // A keystroke re-runs the search as it stands. Prefixes of a term are
        // the realistic case: most keystrokes happen mid-word.
        const term = SEARCH_TERMS[i % SEARCH_TERMS.length] ?? "meeting";
        const typed = term.slice(0, 3 + (i % Math.max(1, term.length - 3)));
        searcher.search(typed, { accountId, now, limit: 50 });
      },
    },
    {
      name: "Local search, first results",
      budgetMs: 150,
      excludes: "rendering the results",
      run(i) {
        // The lane's own done-criterion, verbatim in shape: a field, a flag, a
        // date range and a free-text term together.
        const term = SEARCH_TERMS[i % SEARCH_TERMS.length] ?? "invoice";
        searcher.search(`has:attachment after:2020-01-01 ${term}`, {
          accountId,
          now,
          limit: 50,
        });
      },
    },
    {
      name: "Open thread (cached)",
      budgetMs: 50,
      excludes: "parsing bodies and rendering",
      run(i) {
        const threadId = threadIds[i % Math.max(1, threadIds.length)];
        if (threadId !== undefined) store.getThread(threadId);
      },
    },
  ];

  const runnable = indexed
    ? cases
    : cases.filter(
        (benchCase) =>
          !benchCase.name.startsWith("Keystroke") && !benchCase.name.startsWith("Local search"),
      );
  const results = runnable.map((benchCase) => runCase(benchCase, iterations));

  if (options.location !== undefined) {
    results.push(
      runCase(
        {
          name: "Cold start → first list",
          budgetMs: 1_000,
          excludes: "process start, module load, and the whole interface",
          run() {
            // A fresh connection every time: opening the file, reading the
            // schema version and answering the first query is what a user
            // waits for before anything appears.
            const driver = createNodeDriver({ location: options.location ?? "" });
            const cold = openStore({ driver, projectors: realProjectors });
            cold.schemaVersion();
            cold.queryMessages({ accountId, limit: 50 });
            cold.close();
          },
        },
        Math.min(iterations, 10),
      ),
    );
  }

  return results;
};

export const formatResults = (
  results: readonly BenchResult[],
  context: { population: Population; messages: number },
): string => {
  const lines: string[] = [];
  lines.push(
    `${context.messages.toLocaleString("en")} messages, seed ${context.population.seed}, ` +
      `${process.platform}/${process.arch}, node ${process.versions.node}`,
  );
  lines.push("");
  lines.push("| Interaction | Budget | p50 | p95 | max | Within |");
  lines.push("|---|---|---|---|---|---|");
  for (const result of results) {
    const ms = (value: number) => `${value.toFixed(1)}ms`;
    lines.push(
      `| ${result.name} | ${result.budgetMs}ms | ${ms(result.p50)} | ${ms(result.p95)} | ` +
        `${ms(result.max)} | ${result.withinBudget ? "yes" : "NO"} |`,
    );
  }
  lines.push("");
  lines.push("Every row measures the query only. Excluded, per row:");
  for (const result of results) lines.push(`  ${result.name}: ${result.excludes}`);
  return lines.join("\n");
};
