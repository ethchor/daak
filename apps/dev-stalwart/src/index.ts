/**
 * @daak/dev-stalwart — the development mail server, the seeder, the harness.
 *
 * Week 2, lane D. Its whole reason to exist is that two claims elsewhere in the
 * repo could not be checked without it: that the JMAP adapter works against a
 * real server, and that a query is fast against a real mailbox. Everything here
 * is in service of turning those from assertions into measurements.
 */

export type { GeneratedMessage } from "./generate.js";
export { generate, plannedTotal } from "./generate.js";
export type { Population, SeedMailbox, SizeName } from "./population.js";
export { DEFAULT_MAILBOXES, isSizeName, SIZES } from "./population.js";
export type { Random } from "./random.js";
export { createRandom } from "./random.js";
export type { SeedOptions, SeedResult } from "./seed-store.js";
export { realProjectors, SEED_ACCOUNT, seedMailboxId, seedStore } from "./seed-store.js";
export { sampleWord, VOCABULARY_SIZE, wordAt } from "./vocabulary.js";
