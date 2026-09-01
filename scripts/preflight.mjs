#!/usr/bin/env node
/**
 * Run CI locally, before pushing.
 *
 * This exists because a workflow was pushed that had never been executed, and
 * it failed on its first run for a reason nothing local would have caught: the
 * pnpm version was declared twice, once in `package.json#packageManager` and
 * once as an input to `pnpm/action-setup`, and the action refuses to start when
 * both are set.
 *
 * The lesson is not "be more careful". It is that a check nobody can run before
 * pushing will be discovered by pushing. So:
 *
 * 1. The `run:` steps are read out of `.github/workflows/ci.yml` and executed
 *    verbatim. If someone changes what CI runs, this follows automatically —
 *    there is no second copy of the command list to drift.
 * 2. The `uses:` steps cannot be executed locally, so their configuration is
 *    linted instead, against exactly the contradictions that break them.
 * 3. `pnpm install --frozen-lockfile` runs first, because a stale lockfile is
 *    a CI failure that a plain `pnpm install` locally will never reproduce —
 *    it just quietly fixes it.
 *
 * Usage:
 *   pnpm preflight            everything
 *   pnpm preflight --fast     skip the frozen install (when deps are untouched)
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = join(root, ".github", "workflows", "ci.yml");
const fast = process.argv.includes("--fast");

const problems = [];
const note = (message) => console.log(`  ${message}`);
const fail = (message, detail) => {
  problems.push(detail === undefined ? message : `${message}\n     ${detail}`);
  console.log(`  ✗ ${message}`);
};
const pass = (message) => console.log(`  ✓ ${message}`);
const heading = (message) => console.log(`\n[1m${message}[0m`);

const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const workflow = parse(readFileSync(workflowPath, "utf8"));

// ---------------------------------------------------------------- workflow

heading("Workflow configuration");

const steps = Object.values(workflow.jobs ?? {}).flatMap((job) => job.steps ?? []);

for (const step of steps) {
  if (step.uses === undefined && step.run === undefined) {
    fail(`a step has neither \`uses\` nor \`run\`: ${JSON.stringify(step).slice(0, 60)}`);
  }
}

// The exact failure that motivated this script.
const pnpmSteps = steps.filter((step) => String(step.uses ?? "").startsWith("pnpm/action-setup"));
if (pnpmSteps.length === 0) {
  note("no pnpm/action-setup step — nothing to check");
} else {
  const declaresVersion = pnpmSteps.some((step) => step.with?.version !== undefined);
  if (declaresVersion && packageJson.packageManager !== undefined) {
    fail(
      "pnpm version is declared twice",
      `package.json#packageManager is "${packageJson.packageManager}" and pnpm/action-setup ` +
        "sets `with.version`. The action refuses to start. Remove the `version:` input.",
    );
  } else if (packageJson.packageManager === undefined && !declaresVersion) {
    fail(
      "pnpm version is declared nowhere",
      "Set package.json#packageManager, or give pnpm/action-setup a `version:` input.",
    );
  } else {
    pass(`pnpm version declared once (${packageJson.packageManager ?? "action input"})`);
  }
}

// A runner older than the floor in `engines` fails at install, not at test.
// Majors only: `node-version: 22` means "latest 22.x", and which patch the
// runner picks is not knowable from here — comparing full versions would only
// produce false alarms.
const majorOf = (value) => Number.parseInt(/\d+/.exec(String(value ?? ""))?.[0] ?? "", 10);
const nodeSteps = steps.filter((step) => String(step.uses ?? "").startsWith("actions/setup-node"));
const requiredNode = packageJson.engines?.node;
const requiredMajor = majorOf(requiredNode);

for (const step of nodeSteps) {
  const configured = step.with?.["node-version"];
  const usedMajor = majorOf(configured);
  if (!Number.isFinite(usedMajor)) {
    fail("actions/setup-node has no readable `node-version`");
  } else if (Number.isFinite(requiredMajor) && usedMajor < requiredMajor) {
    fail(
      `CI runs Node ${configured}, but engines.node requires ${requiredNode}`,
      "Install fails on the runner before a single test runs.",
    );
  } else {
    pass(`Node ${configured} satisfies engines.node ${requiredNode}`);
  }
}

// Every `needs` has to name a job that exists, or the run silently never starts.
const jobIds = new Set(Object.keys(workflow.jobs ?? {}));
for (const [id, job] of Object.entries(workflow.jobs ?? {})) {
  for (const need of [job.needs ?? []].flat()) {
    if (!jobIds.has(need)) fail(`job \`${id}\` needs \`${need}\`, which does not exist`);
  }
}
pass(`${jobIds.size} jobs, all \`needs\` resolve`);

// ------------------------------------------------------------- branch name

heading("Branch name");

let branch = "";
try {
  branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: root, encoding: "utf8" }).trim();
} catch {
  note("not a git checkout — skipping");
}

const LONG_LIVED = new Set(["develop", "main"]);
const CONVENTION = /^(feat|fix|refactor|perf|test|docs|chore|spike)\/[a-z0-9][a-z0-9._-]*$/;
const RELEASE = /^(release|hotfix)\/\d+\.\d+\.\d+$/;

if (branch === "") {
  // already noted
} else if (LONG_LIVED.has(branch)) {
  pass(`${branch} (long-lived branch)`);
} else if (CONVENTION.test(branch) || RELEASE.test(branch)) {
  pass(branch);
} else {
  fail(
    `branch \`${branch}\` does not follow the convention`,
    "Expected <type>/<slug> — feat, fix, refactor, perf, test, docs, chore, spike — " +
      "or release/x.y.z. CI rejects this on a pull request.",
  );
}

// --------------------------------------------------------- the actual CI

const run = (command, label) => {
  heading(label);
  try {
    execSync(command, { cwd: root, stdio: "inherit" });
    console.log(`  ✓ ${command}`);
    return true;
  } catch {
    fail(`\`${command}\` failed`);
    return false;
  }
};

if (!fast) {
  // The one command that cannot come from the workflow's own step list without
  // running it twice — and the one whose local equivalent (`pnpm install`)
  // silently fixes what CI would fail on.
  run("pnpm install --frozen-lockfile --prefer-offline", "Lockfile (frozen install)");
} else {
  heading("Lockfile (frozen install)");
  note("skipped (--fast)");
}

const checkJob = workflow.jobs?.check;
const commands = (checkJob?.steps ?? [])
  .filter((step) => typeof step.run === "string")
  .map((step) => step.run.trim())
  .filter((command) => !command.startsWith("pnpm install"));

if (commands.length === 0) {
  fail("no `run:` steps found in the `check` job — is the workflow still shaped as expected?");
}

for (const command of commands) {
  run(command, `CI step: ${command}`);
}

// ------------------------------------------------------------------ verdict

heading(problems.length === 0 ? "Preflight passed" : `Preflight failed (${problems.length})`);
for (const problem of problems) console.log(`  ✗ ${problem}`);
if (problems.length === 0) console.log("  Safe to push.");
process.exit(problems.length === 0 ? 0 : 1);
