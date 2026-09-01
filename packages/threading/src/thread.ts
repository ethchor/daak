import {
  type AccountId,
  type EmailAddress,
  type Thread,
  type ThreadId,
  threadId as toThreadId,
} from "@daak/contracts";
import { buildGraph, type Container, collectMessages } from "./container.js";
import { normaliseSubject } from "./subject.js";
import type { ThreadableMessage } from "./types.js";

/**
 * Thread ids are derived from content, never assigned by a counter.
 *
 * Rebuilding the store must produce byte-identical threads, which rules out
 * anything stateful. The id is the root container's Message-ID, which stays the
 * same as the thread grows downwards — new replies join, the root does not move.
 *
 * A late-arriving *ancestor* does re-root a thread and change its id. That is
 * real and unavoidable: it is the same event that makes every mail client
 * suddenly merge two conversations. The store handles it as a merge.
 */
const MAX_ROOT_ID = 440;

const fnv1a = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

const deriveThreadId = (rootId: string): ThreadId =>
  toThreadId(
    rootId.length <= MAX_ROOT_ID
      ? `t:${rootId}`
      : // Absurdly long Message-IDs exist. Keep the readable head so the id is
        // still greppable, and disambiguate the tail.
        `t:${rootId.slice(0, MAX_ROOT_ID)}~${fnv1a(rootId)}`,
  );

/** Union of everyone on the thread, first appearance first, deduped by address. */
const collectParticipants = (messages: readonly ThreadableMessage[]): EmailAddress[] => {
  const seen = new Set<string>();
  const participants: EmailAddress[] = [];
  for (const message of messages) {
    for (const address of [...message.from, ...message.to, ...message.cc]) {
      const key = address.address.toLowerCase();
      if (key === "" || seen.has(key)) continue;
      seen.add(key);
      participants.push(address);
    }
  }
  return participants;
};

/**
 * Merge root containers that share a normalised subject.
 *
 * JWZ's last step, and the one with a bad reputation: applied naively it merges
 * every "Hello" anyone ever sent into one enormous thread.
 *
 * Two narrowings keep it honest. It runs only after References and In-Reply-To
 * are exhausted, so anything with real ancestry is already threaded. And it
 * merges only when at least one side actually carried a reply prefix — two
 * unrelated messages both titled "Lunch" stay apart, while "Lunch" and
 * "Re: Lunch" come together.
 */
const groupBySubject = (roots: readonly Container[]): Container[] => {
  interface Entry {
    container: Container;
    wasReply: boolean;
  }
  const bySubject = new Map<string, Entry>();
  const merged = new Set<Container>();

  const subjectOf = (container: Container): string =>
    container.message?.subject ?? container.children[0]?.message?.subject ?? "";

  for (const root of roots) {
    const { base, wasReply, wasForward } = normaliseSubject(subjectOf(root));
    if (base === "") continue;
    // A forward takes part in subject grouping in neither direction. It is not
    // a reply, so it never joins a thread — and it must not become the thread a
    // later reply joins either, or "Re: numbers" lands on someone's forward of
    // the conversation instead of the conversation itself.
    if (wasForward && !wasReply) continue;

    const existing = bySubject.get(base);
    if (existing === undefined) {
      bySubject.set(base, { container: root, wasReply });
      continue;
    }
    if (!existing.wasReply && !wasReply) {
      // Neither is a reply. Same words, no evidence of a conversation.
      continue;
    }

    // The one that is not a reply is the parent. When both are, the earlier one
    // wins — processing order is already oldest-first, so that is `existing`.
    const parent = existing.wasReply && !wasReply ? root : existing.container;
    const child = parent === root ? existing.container : root;

    child.parent = parent;
    parent.children.push(child);
    merged.add(child);
    bySubject.set(base, {
      container: parent,
      wasReply: parent === root ? wasReply : existing.wasReply,
    });
  }

  return roots.filter((root) => !merged.has(root));
};

export interface ThreadingInput {
  readonly accountId: AccountId;
  readonly messages: readonly ThreadableMessage[];
}

/**
 * Group messages into threads.
 *
 * Pure and total: no clock, no I/O, no randomness, and the same input always
 * produces byte-identical output regardless of the order it arrives in.
 *
 * Provider thread ids are deliberately not an input. Providers disagree with
 * each other and with themselves, and a thread that reshapes when you switch
 * provider is a bug users can see.
 */
export const threadMessages = ({ accountId, messages }: ThreadingInput): Thread[] => {
  if (messages.length === 0) return [];

  const { roots } = buildGraph(messages);
  const threads: Thread[] = [];

  for (const root of groupBySubject(roots)) {
    const members = collectMessages(root);
    if (members.length === 0) continue;

    const first = members[0];
    const last = members[members.length - 1];
    if (first === undefined || last === undefined) continue;

    threads.push({
      id: deriveThreadId(root.id),
      accountId,
      messageIds: members.map((message) => message.id),
      subject: normaliseSubject(root.message?.subject ?? first.subject).base,
      participants: collectParticipants(members),
      lastMessageAt: last.receivedAt,
      messageCount: members.length,
    });
  }

  // Newest activity first, ties broken by id so the order is total.
  return threads.sort((a, b) => {
    if (a.lastMessageAt !== b.lastMessageAt) return a.lastMessageAt > b.lastMessageAt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
};

/** The thread a single message belongs to, for callers that only need the id. */
export const threadIdFor = (input: ThreadingInput, messageId: string): ThreadId | undefined =>
  threadMessages(input).find((thread) => thread.messageIds.includes(messageId as never))?.id;
