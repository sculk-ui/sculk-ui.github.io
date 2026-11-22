// This browser's static key, kept in IndexedDB so that a game that
// remembers it lets it back in without asking. IndexedDB stores the
// non-extractable CryptoKey as it is: scripts here can use it, but nothing
// can read it out. A browser may still evict it (Safari does after weeks
// unused), and then the game asks again.

import { type KeyPair, generateKeyPair } from "./noise";

const DB = "sculk";
const STORE = "keys";
const BROWSER_KEY = "browser";

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function open(): Promise<IDBDatabase> {
  const r = indexedDB.open(DB, 1);
  r.onupgradeneeded = () => r.result.createObjectStore(STORE);
  return request(r);
}

/** The key, and whether it is kept (false: a fresh one this time, which a game cannot remember). */
export async function browserKey(): Promise<{ key: KeyPair; kept: boolean }> {
  try {
    const db = await open();
    try {
      const found = (await request(db.transaction(STORE).objectStore(STORE).get(BROWSER_KEY))) as KeyPair | undefined;
      if (found !== undefined) return { key: found, kept: true };
      const key = await generateKeyPair(false);
      await request(db.transaction(STORE, "readwrite").objectStore(STORE).put(key, BROWSER_KEY));
      // Ask not to be evicted under storage pressure; browsers may say no.
      void navigator.storage?.persist?.();
      return { key, kept: true };
    } finally {
      db.close();
    }
  } catch {
    // No IndexedDB (some private windows): a key for this visit only.
    return { key: await generateKeyPair(false), kept: false };
  }
}
