/**
 * @daak/threading — JWZ threading, deterministic.
 *
 * Pure, total, header-only. Same input, same output, always: rebuilding the
 * store must produce byte-identical threads, and a conversation that reshapes
 * on a rebuild is a bug users can see.
 */

export type { Container, Graph } from "./container.js";
export { buildGraph, collectMessages, inProcessingOrder, referenceChain } from "./container.js";
export type { NormalisedSubject } from "./subject.js";
export { normaliseSubject } from "./subject.js";
export type { ThreadingInput } from "./thread.js";
export { threadIdFor, threadMessages } from "./thread.js";
export type { ThreadableMessage } from "./types.js";
