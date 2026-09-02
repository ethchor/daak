/**
 * @daak/adapter-jmap — a `MailProvider` over JMAP (RFC 8620, RFC 8621).
 *
 * No JMAP vocabulary leaves this package. State strings become opaque cursors,
 * roles become `MailboxRole`, and every `SetError` is mapped explicitly onto
 * the error taxonomy — see `errors.ts`, where the default branch is deliberate
 * rather than an oversight.
 */

export type {
  JmapClient,
  JmapClientOptions,
  JmapSession,
  MethodCall,
  MethodResponse,
} from "./client.js";
export { createJmapClient, responseFor } from "./client.js";
export type { JmapProblem } from "./errors.js";
export { mapHttpError, mapJmapError } from "./errors.js";
export {
  buildPatch,
  escapePointer,
  keysOf,
  toMailboxRole,
  toProviderMailbox,
  toProviderMessage,
} from "./mapping.js";
export type { JmapProviderOptions } from "./provider.js";
export { createJmapProvider } from "./provider.js";
