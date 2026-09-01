import type { Capability } from "../capabilities.js";
import type { AccountId, BlobId, CommandId, MessageId, ThreadId } from "../ids.js";
import type { Annotation, AnnotationDraft } from "../model/annotation.js";
import type { Mailbox } from "../model/mailbox.js";
import type { Message } from "../model/message.js";
import type { Thread } from "../model/thread.js";
import type { Cancellable, Page } from "../primitives.js";
import type { CommandResult } from "./command.js";

/**
 * SEAM 8 — Integration.
 *
 * The read surface plus annotation writes plus command invocation. This one
 * interface is what an MCP server exposes to an agent, what a plugin gets, and
 * what a future calendar or CRM integration talks to.
 *
 * Everything is capability-checked. `grantedCapabilities` is what the caller
 * actually holds, and a call outside it fails with `capability.denied` rather
 * than returning a filtered result — silently returning less is how integrations
 * develop superstitions.
 */
export interface MessageQuery {
  readonly accountId: AccountId;
  readonly mailboxId?: string;
  readonly threadId?: ThreadId;
  readonly keywords?: readonly string[];
  readonly notKeywords?: readonly string[];
  readonly receivedAfter?: string;
  readonly receivedBefore?: string;
  readonly limit?: number;
  readonly cursor?: string | null;
}

export interface SearchQuery {
  readonly accountId: AccountId;
  /** Daak query syntax: `from:asha has:attachment after:2026-01-01 invoice`. */
  readonly query: string;
  readonly limit?: number;
  readonly cursor?: string | null;
}

export interface SearchHit {
  readonly messageId: MessageId;
  readonly threadId: ThreadId;
  readonly score: number;
  /** Highlighted excerpt. Never the full body. */
  readonly snippet: string;
}

export interface DaakApi {
  readonly grantedCapabilities: readonly Capability[];

  listMailboxes(accountId: AccountId, options?: Cancellable): Promise<readonly Mailbox[]>;
  queryMessages(query: MessageQuery, options?: Cancellable): Promise<Page<Message>>;
  getMessage(id: MessageId, options?: Cancellable): Promise<Message | null>;
  getThread(id: ThreadId, options?: Cancellable): Promise<Thread | null>;
  search(query: SearchQuery, options?: Cancellable): Promise<Page<SearchHit>>;

  /** Requires `mail:read-body`. Decoded, never raw. */
  getBody(id: MessageId, options?: Cancellable): Promise<{ text?: string; html?: string }>;
  /** Requires `blob:read`. */
  getBlob(id: BlobId, options?: Cancellable): Promise<Uint8Array>;

  listAnnotations(
    subject: { kind: "message" | "thread"; id: string },
    options?: Cancellable,
  ): Promise<readonly Annotation[]>;
  /** The ONLY write in this interface. Requires `annotation:write`. */
  writeAnnotation(draft: AnnotationDraft, options?: Cancellable): Promise<Annotation>;

  /** Requires `command:invoke:<id>`. Everything else goes through here. */
  invoke(commandId: CommandId, args: unknown): Promise<CommandResult>;
}
