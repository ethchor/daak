import type { BlobId } from "../ids.js";
import type { Cancellable } from "../primitives.js";

/**
 * SEAM 5 — Blob store.
 *
 * Content-addressed, immutable, append-only. Ships with a filesystem
 * implementation; S3, OPFS and IndexedDB are the same interface.
 *
 * `put` computes the digest itself and returns it. A store that trusts a
 * caller-supplied id is not content-addressed, it is a filename.
 */
export interface BlobRef {
  readonly id: BlobId;
  readonly size: number;
}

export interface BlobStore {
  /** Returns the existing ref when the bytes are already stored. Idempotent. */
  put(bytes: Uint8Array, options?: Cancellable): Promise<BlobRef>;
  get(id: BlobId, options?: Cancellable): Promise<Uint8Array>;
  /** Streaming read for large attachments. Optional; `get` is always present. */
  stream?(id: BlobId, options?: Cancellable): Promise<ReadableStream<Uint8Array>>;
  has(id: BlobId): Promise<boolean>;
  stat(id: BlobId): Promise<BlobRef | null>;
  /**
   * Only ever called by garbage collection, after the last reference is gone.
   * No product code deletes a blob.
   */
  delete(id: BlobId): Promise<void>;
}
