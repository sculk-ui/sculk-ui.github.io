// This browser's static key, kept in IndexedDB so that a game that
// remembers it lets it back in without asking; and the servers it has
// reached, so it can go back to one without its link. IndexedDB stores the
// non-extractable CryptoKey as it is: scripts here can use it, but nothing
// can read it out. A browser may still evict it (Safari does after weeks
// unused), and then the game asks again.

import { type KeyPair, generateKeyPair } from "./noise";

const DB = "sculk";
const STORE = "keys";
const SERVERS = "servers";
const BROWSER_KEY = "browser";

/** A server this browser has reached: its key (base64url, as in its link) and a name. */
export interface SavedServer {
  key: string;
  /** The user's, or the game's platform ("neoforge 1.21.1"); "" until either is known. */
  name: string;
  added: number;
  lastConnected: number;
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function open(): Promise<IDBDatabase> {
  const r = indexedDB.open(DB, 2);
  r.onupgradeneeded = () => {
    const db = r.result;
    if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    if (!db.objectStoreNames.contains(SERVERS)) db.createObjectStore(SERVERS, { keyPath: "key" });
  };
  return request(r);
}

async function withServers<T>(mode: IDBTransactionMode, f: (store: IDBObjectStore) => Promise<T>): Promise<T> {
  const db = await open();
  try {
    return await f(db.transaction(SERVERS, mode).objectStore(SERVERS));
  } finally {
    db.close();
  }
}

/** The servers kept, the most recently connected first; none when IndexedDB is unavailable. */
export async function savedServers(): Promise<SavedServer[]> {
  try {
    const all = await withServers("readonly", (s) => request(s.getAll() as IDBRequest<SavedServer[]>));
    return all.sort((a, b) => b.lastConnected - a.lastConnected);
  } catch {
    return [];
  }
}

export async function savedServer(key: string): Promise<SavedServer | undefined> {
  try {
    return await withServers("readonly", (s) => request(s.get(key) as IDBRequest<SavedServer | undefined>));
  } catch {
    return undefined;
  }
}

/**
 * Keeps a server just connected to, or marks it connected now; a name is
 * set only where there is none, so the user's stands. Returns what is kept,
 * or undefined when nothing can be.
 */
export async function keepServer(key: string, name = ""): Promise<SavedServer | undefined> {
  try {
    return await withServers("readwrite", async (s) => {
      const now = Date.now();
      const old = (await request(s.get(key) as IDBRequest<SavedServer | undefined>)) ?? { key, name: "", added: now, lastConnected: now };
      const kept: SavedServer = { ...old, name: old.name || name, lastConnected: now };
      await request(s.put(kept));
      return kept;
    });
  } catch {
    return undefined;
  }
}

/** Names a kept server, as the user asked; does nothing for one not kept. */
export async function renameServer(key: string, name: string): Promise<void> {
  await withServers("readwrite", async (s) => {
    const old = (await request(s.get(key) as IDBRequest<SavedServer | undefined>));
    if (old) await request(s.put({ ...old, name }));
  });
}

export async function forgetServer(key: string): Promise<void> {
  await withServers("readwrite", (s) => request(s.delete(key)).then(() => undefined));
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
