import {
  type BlobId,
  type BlobRef,
  type BlobStore,
  blobIdFromDigest,
  DaakError,
  ErrorCodes,
  nowInstant,
} from "@daak/contracts";
import { asNumber, prepareLazily, type SqliteDriver } from "./driver.js";

const HEX = "0123456789abcdef";

const toHex = (bytes: Uint8Array): string => {
  let out = "";
  for (const byte of bytes) {
    out += HEX[byte >> 4];
    out += HEX[byte & 15];
  }
  return out;
};

/**
 * Web Crypto rather than `node:crypto`: the same store runs in a browser
 * worker, and this is the one hashing API that exists in both.
 */
export const digestBlob = async (bytes: Uint8Array): Promise<BlobId> => {
  // The cast is for the type only: `BufferSource` lives in the DOM lib, which
  // this package deliberately does not pull in.
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return blobIdFromDigest(toHex(new Uint8Array(digest)));
};

/**
 * A content-addressed blob store over SQLite.
 *
 * The id *is* the digest, computed here. A store that trusts a caller-supplied
 * id is not content-addressed, it is a filename — and the whole deduplication,
 * verification and rebuild story rests on the id being the bytes.
 */
export const createBlobStore = (driver: SqliteDriver): BlobStore => {
  const insert = prepareLazily(
    driver,
    "insert or ignore into blobs (id, size, bytes, created_at) values (?, ?, ?, ?)",
  );
  const select = prepareLazily(driver, "select bytes from blobs where id = ?");
  const selectStat = prepareLazily(driver, "select id, size from blobs where id = ?");
  const remove = prepareLazily(driver, "delete from blobs where id = ?");

  return {
    async put(bytes) {
      const id = await digestBlob(bytes);
      // `insert or ignore`: storing the same message twice is the normal case,
      // not a conflict. Two accounts with the same mail share the row.
      insert.run(id, bytes.byteLength, bytes, nowInstant());
      return { id, size: bytes.byteLength };
    },

    async get(id) {
      const row = select.get(id);
      const bytes = row?.bytes;
      if (!(bytes instanceof Uint8Array)) {
        throw DaakError.permanent(ErrorCodes.NOT_FOUND, "no such blob", { context: { id } });
      }
      return bytes;
    },

    async has(id) {
      return selectStat.get(id) !== undefined;
    },

    async stat(id): Promise<BlobRef | null> {
      const row = selectStat.get(id);
      if (row === undefined) return null;
      return { id, size: asNumber(row.size) };
    },

    async delete(id) {
      // Only garbage collection calls this, after the last reference is gone.
      // The foreign key from `messages` stops a referenced blob disappearing.
      remove.run(id);
    },
  };
};

/**
 * Re-verify that stored bytes still hash to their id.
 *
 * Nothing calls this on the read path — it would double the cost of every
 * message open. It exists for the integrity check a user can run when they
 * suspect their disk, and for the rebuild path.
 */
export const verifyBlob = async (store: BlobStore, id: BlobId): Promise<boolean> => {
  const bytes = await store.get(id);
  return (await digestBlob(bytes)) === id;
};
