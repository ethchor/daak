/**
 * @daak/contracts — the constitution in TypeScript.
 *
 * Every other package depends on this one, and this one depends on nothing but
 * zod. If you are about to add a dependency here, stop: it will end up in the
 * browser bundle, the worker, the server and every plugin.
 *
 * LOCKED after week 0. See CONTRIBUTING.md before changing anything in here.
 */

export * from "./capabilities.js";
export * from "./errors.js";
export * from "./ids.js";
// Persisted shapes
export * from "./model/account.js";
export * from "./model/annotation.js";
export * from "./model/event.js";
export * from "./model/intent.js";
export * from "./model/mailbox.js";
export * from "./model/message.js";
export * from "./model/sync.js";
export * from "./model/thread.js";
export * from "./primitives.js";
export * from "./seams/annotator.js";
export * from "./seams/api.js";
export * from "./seams/blob-store.js";
export * from "./seams/command.js";
export * from "./seams/llm.js";
export * from "./seams/plugin.js";
// The eight seams
export * from "./seams/provider.js";
export * from "./seams/rule.js";
export * from "./seams/view.js";
export * from "./version.js";
