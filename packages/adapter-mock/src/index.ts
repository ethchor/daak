/**
 * @daak/adapter-mock — a deterministic `MailProvider` with fault injection.
 *
 * Every other lane develops against this: no credentials, no rate limits, no
 * flakiness, and a failing chaos run reproduces from its seed alone.
 *
 * See ./CLAUDE.md for the faults it must be able to inject and why
 * `apply-then-fail` is the one that matters most.
 */

export type { FaultController, FaultKind, FaultRule, ProviderOp } from "./faults.js";
export { createFaultEngine, FAULT_KINDS } from "./faults.js";
export type { MockProvider, MockProviderOptions } from "./provider.js";
export { createMockProvider } from "./provider.js";
export type { Rng } from "./rng.js";
export { createRng, seedFrom } from "./rng.js";
export type { AddMessageInput, MockServerOptions, ServerMessage } from "./server.js";
export { MockServer, toProviderMessage } from "./server.js";
