import { benchmark, formatResults } from "./bench.js";
import { isSizeName, type Population, SIZES } from "./population.js";
import { seedStore } from "./seed-store.js";

/**
 * The seeder and the harness, from a terminal.
 *
 *     node --experimental-strip-types src/cli.ts seed 50k --out ./seed-50k.sqlite
 *     node --experimental-strip-types src/cli.ts bench 50k
 *
 * `bench` seeds and measures in one process by default, because a mailbox that
 * exists only to be measured is not worth keeping. `--out` keeps it.
 */
const usage = `daak dev-stalwart

  seed <1k|50k|500k> [--out <path>] [--seed <n>] [--messages <n>] [--no-index]
  bench <1k|50k|500k> [--out <path>] [--seed <n>] [--messages <n>] [--iterations <n>]

--messages overrides the count while keeping the size's other distributions,
which is how you measure something at a volume no named size covers.

Sizes are message counts. 500k takes a while and wants a path, not memory.`;

interface Flags {
  readonly out?: string | undefined;
  readonly seed?: number | undefined;
  readonly iterations?: number | undefined;
  readonly messages?: number | undefined;
  readonly index: boolean;
}

const parseFlags = (argv: readonly string[]): Flags => {
  let out: string | undefined;
  let seed: number | undefined;
  let iterations: number | undefined;
  let messages: number | undefined;
  let index = true;

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--out") out = argv[++i];
    else if (flag === "--seed") seed = Number(argv[++i]);
    else if (flag === "--iterations") iterations = Number(argv[++i]);
    else if (flag === "--messages") messages = Number(argv[++i]);
    else if (flag === "--no-index") index = false;
  }
  return { out, seed, iterations, messages, index };
};

const progress = (done: number, total: number): void => {
  const percent = total === 0 ? 100 : Math.floor((done / total) * 100);
  process.stderr.write(
    `\r  seeded ${done.toLocaleString("en")}/${total.toLocaleString("en")} (${percent}%)`,
  );
};

const main = async (): Promise<number> => {
  const [command, size, ...rest] = process.argv.slice(2);

  if (command === undefined || size === undefined || !isSizeName(size)) {
    process.stdout.write(`${usage}\n`);
    return command === undefined ? 0 : 1;
  }

  const flags = parseFlags(rest);
  const population: Population = {
    ...SIZES[size],
    ...(flags.seed === undefined || Number.isNaN(flags.seed) ? {} : { seed: flags.seed }),
    ...(flags.messages === undefined || Number.isNaN(flags.messages)
      ? {}
      : { messages: flags.messages }),
  };

  if (command !== "seed" && command !== "bench") {
    process.stdout.write(`${usage}\n`);
    return 1;
  }

  process.stderr.write(`Seeding ${population.messages.toLocaleString("en")} messages…\n`);
  const seeded = await seedStore({
    population,
    location: flags.out,
    index: flags.index,
    onProgress: progress,
  });
  process.stderr.write("\n");

  const { timings } = seeded;
  process.stdout.write(
    `Seeded ${seeded.messages.toLocaleString("en")} messages in ${(timings.total / 1000).toFixed(1)}s ` +
      `(blobs ${(timings.blobs / 1000).toFixed(1)}s, project ${(timings.project / 1000).toFixed(1)}s, ` +
      `index ${(timings.index / 1000).toFixed(1)}s)\n`,
  );

  if (command === "bench") {
    const results = benchmark({
      store: seeded.store,
      accountId: seeded.accountId,
      mailboxes: seeded.mailboxes,
      now: population.endsAt as never,
      iterations: flags.iterations,
      location: flags.out,
    });
    process.stdout.write(
      `\n${formatResults(results, { population, messages: seeded.messages })}\n`,
    );
  }

  seeded.store.close();
  return 0;
};

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  },
);
