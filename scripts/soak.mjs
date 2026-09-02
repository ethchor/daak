#!/usr/bin/env node
/**
 * Run the property suites repeatedly, with a fresh random seed each time.
 *
 * `pnpm preflight` runs the tests exactly once, because that is what CI does.
 * For property-based suites once is not enough: each run explores a different
 * slice of the input space, so a bug can pass locally and fail on the runner
 * purely because the two rolled different seeds. That happened — the sync
 * engine passed 200 property cases here and failed on its first CI run, and the
 * counterexample was real.
 *
 * So after touching a package with properties — `sync`, `store`, `threading` —
 * soak it before pushing. Ten runs is roughly two thousand cases and takes
 * under a minute.
 *
 * Usage:
 *   pnpm soak                     ten runs of the property packages
 *   pnpm soak 25                  twenty-five runs
 *   pnpm soak 10 packages/sync    a specific target
 */
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const runs = Number.parseInt(args[0] ?? "10", 10);
const target = args[1] ?? "packages/sync packages/store packages/threading";

if (!Number.isFinite(runs) || runs < 1) {
  console.error("usage: pnpm soak [runs] [target]");
  process.exit(2);
}

console.log(`Soaking ${target} — ${runs} runs, fresh seeds each time.\n`);

const failures = [];
const started = Date.now();

for (let run = 1; run <= runs; run += 1) {
  try {
    execSync(`npx vitest run ${target}`, { cwd: root, stdio: "pipe", encoding: "utf8" });
    process.stdout.write(`  ${run} ✓`);
  } catch (error) {
    process.stdout.write(`  ${run} ✗`);
    const output = String(error.stdout ?? "") + String(error.stderr ?? "");
    // The counterexample is the whole value of a failure — print it, not a
    // stack trace nobody can act on.
    const counterexample = /Counterexample: (.*)/.exec(output)?.[1];
    failures.push({ run, counterexample: counterexample ?? "(no counterexample in output)" });
  }
  if (run % 10 === 0) process.stdout.write("\n");
}

const seconds = Math.round((Date.now() - started) / 100) / 10;
console.log(`\n\n${runs - failures.length}/${runs} passed in ${seconds}s.`);

if (failures.length > 0) {
  console.log("\nCounterexamples:");
  for (const failure of failures) {
    console.log(`  run ${failure.run}: ${failure.counterexample}`);
  }
  console.log(
    "\nPin any counterexample you fix into the property's `examples`, so it is" +
      "\nchecked on every run rather than when a seed happens to rediscover it.",
  );
  process.exit(1);
}
