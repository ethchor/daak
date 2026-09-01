import type { ThreadableMessage } from "./types.js";

/**
 * The JWZ container graph.
 *
 * https://www.jwz.org/doc/threading.html — the algorithm is published and
 * settled, so this file follows it rather than inventing anything. What it adds
 * is determinism: every iteration order here is fixed, because a threading
 * function that depends on Map insertion order produces different threads on a
 * rebuild, and a thread that reshapes when the store is rebuilt is a bug users
 * can see.
 */
export interface Container {
  /** The Message-ID this container stands for. Synthetic for messages without one. */
  readonly id: string;
  message: ThreadableMessage | undefined;
  parent: Container | undefined;
  children: Container[];
}

const createContainer = (id: string): Container => ({
  id,
  message: undefined,
  parent: undefined,
  children: [],
});

/** Would linking `child` under `parent` create a cycle? */
const wouldCycle = (parent: Container, child: Container): boolean => {
  if (parent === child) return true;
  for (let node: Container | undefined = parent; node !== undefined; node = node.parent) {
    if (node === child) return true;
  }
  return false;
};

const link = (parent: Container, child: Container): void => {
  if (child.parent !== undefined) return; // never re-parent; first link wins
  if (wouldCycle(parent, child)) return;
  child.parent = parent;
  parent.children.push(child);
};

const unlink = (child: Container): void => {
  const parent = child.parent;
  if (parent === undefined) return;
  parent.children = parent.children.filter((candidate) => candidate !== child);
  child.parent = undefined;
};

/**
 * The ancestry a message claims, oldest first.
 *
 * `References` is authoritative when present. `In-Reply-To` is appended when it
 * names something References did not — plenty of clients emit one and not the
 * other, and the corpus has a fixture for exactly that case.
 */
export const referenceChain = (message: ThreadableMessage): string[] => {
  const chain = [...message.references];
  for (const id of message.inReplyTo) {
    if (!chain.includes(id)) chain.push(id);
  }
  return chain;
};

/**
 * Deterministic processing order: oldest first, ties broken by local id.
 *
 * Threading is order-sensitive — whoever claims a Message-ID first owns it —
 * so the order is fixed here rather than inherited from however the caller
 * happened to query the store.
 */
export const inProcessingOrder = (
  messages: readonly ThreadableMessage[],
): readonly ThreadableMessage[] =>
  [...messages].sort((a, b) => {
    if (a.receivedAt !== b.receivedAt) return a.receivedAt < b.receivedAt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

export interface Graph {
  readonly roots: readonly Container[];
  /** Which container ended up holding each message. */
  readonly containerOf: ReadonlyMap<string, Container>;
}

export const buildGraph = (messages: readonly ThreadableMessage[]): Graph => {
  const table = new Map<string, Container>();
  const containerOf = new Map<string, Container>();

  const lookup = (id: string): Container => {
    const existing = table.get(id);
    if (existing !== undefined) return existing;
    const created = createContainer(id);
    table.set(id, created);
    return created;
  };

  for (const message of inProcessingOrder(messages)) {
    // A message with no Message-ID still has to thread. A message whose id is
    // already claimed gets its own container rather than overwriting the first
    // claimant: two distinct messages sharing a Message-ID is malformed input,
    // not permission to lose one of them.
    const declared = message.messageIdHeader[0];
    let container: Container;
    if (declared === undefined || table.get(declared)?.message !== undefined) {
      container = createContainer(`local:${message.id}`);
      table.set(container.id, container);
    } else {
      container = lookup(declared);
    }
    container.message = message;
    containerOf.set(message.id, container);

    // Link the ancestry into a chain, parent to child, in order.
    const chain = referenceChain(message);
    let previous: Container | undefined;
    for (const id of chain) {
      const node = lookup(id);
      if (previous !== undefined) link(previous, node);
      previous = node;
    }

    // The message hangs off the last thing it referenced. If it already has a
    // parent from an earlier pass, that link stands.
    if (previous !== undefined && container.parent === undefined) {
      link(previous, container);
    }
  }

  const roots = [...table.values()].filter((container) => container.parent === undefined);
  return { roots: prune(roots), containerOf };
};

/**
 * Drop containers that stand for messages we have never seen.
 *
 * A `References` chain names ancestors that may not be in this mailbox at all.
 * Those placeholders hold the shape together while threading, and would show up
 * as empty rows if they survived into the result.
 */
const prune = (roots: readonly Container[]): Container[] => {
  const visit = (container: Container): void => {
    // Copy: children are re-parented during the walk.
    for (const child of [...container.children]) visit(child);

    if (container.message !== undefined) return;

    if (container.children.length === 0) {
      unlink(container);
      return;
    }

    const parent = container.parent;
    if (parent !== undefined) {
      for (const child of [...container.children]) {
        unlink(child);
        link(parent, child);
      }
      unlink(container);
    }
  };

  for (const root of [...roots]) visit(root);

  const survivors: Container[] = [];
  for (const root of roots) {
    if (root.parent !== undefined) continue; // was re-parented during pruning
    if (root.message === undefined && root.children.length === 0) continue;
    if (root.message === undefined && root.children.length === 1) {
      // An empty root with a single real child is just that child.
      const only = root.children[0];
      if (only !== undefined) {
        unlink(only);
        survivors.push(only);
        continue;
      }
    }
    survivors.push(root);
  }
  return survivors;
};

/** Every message in a subtree, oldest first. */
export const collectMessages = (container: Container): ThreadableMessage[] => {
  const found: ThreadableMessage[] = [];
  const walk = (node: Container): void => {
    if (node.message !== undefined) found.push(node.message);
    for (const child of node.children) walk(child);
  };
  walk(container);
  return found.sort((a, b) => {
    if (a.receivedAt !== b.receivedAt) return a.receivedAt < b.receivedAt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
};

export { link, unlink };
