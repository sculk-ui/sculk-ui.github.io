// Nostr as remote access uses it (schlarpc/sculk's docs/REMOTE.md): topics,
// which relays a topic lives on, and signed ephemeral events. The game's
// side is core/.../remote/Nostr.java; test/nostr-vectors.json pins both.

import { newSecretKey, publicKey, sign } from "./bip340";
import type { Bytes } from "./noise";

/** How many relays the browser uses for a topic; the game uses 8. */
export const BROWSER_RELAYS = 5;
/** How far back a subscription looks, for clocks that disagree. */
export const CLOCK_SKEW_SECONDS = 60;

const TOPIC = /^[0-9a-f]{64}$/;
const BASE64 = /^[A-Za-z0-9+/=]*$/;

const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const ascii = (s: string): Bytes => new TextEncoder().encode(s) as Bytes;

async function sha256(...parts: Uint8Array[]): Promise<Bytes> {
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", all));
}

function checkTopic(topic: string): void {
  if (!TOPIC.test(topic)) throw new Error(`topic: ${topic}`);
}

/** The topic the game listens on: hex(SHA-256("sculk/v1/server" || server key)). */
export async function serverTopic(serverKey: Uint8Array): Promise<string> {
  return toHex(await sha256(ascii("sculk/v1/server"), serverKey));
}

/** The ephemeral event kind for a topic: 20000 + its first two bytes mod 10000. */
export function kind(topic: string): number {
  checkTopic(topic);
  return 20000 + (parseInt(topic.slice(0, 4), 16) % 10000);
}

/** The relays for a topic, best first, by SHA-256(topic || url). */
export async function relaysFor(topic: string, relays: readonly string[]): Promise<string[]> {
  checkTopic(topic);
  const scored = await Promise.all(relays.map(async (url) => ({ url, h: await sha256(ascii(topic), new TextEncoder().encode(url)) })));
  scored.sort((a, b) => {
    for (let i = 0; i < 32; i++) if (a.h[i] !== b.h[i]) return a.h[i]! - b.h[i]!;
    return 0;
  });
  return scored.map((s) => s.url);
}

/** The subscription filter for a topic's events since `nowSeconds` less the clock skew. */
export function filter(topic: string, nowSeconds: number): { kinds: number[]; "#x": string[]; since: number } {
  return { kinds: [kind(topic)], "#x": [topic], since: Math.max(0, nowSeconds - CLOCK_SKEW_SECONDS) };
}

/** A throwaway signing key, one per session. */
export class Signer {
  readonly pubkey: string;

  constructor(private readonly secretKey: Uint8Array = newSecretKey()) {
    this.pubkey = toHex(publicKey(secretKey));
  }

  private lastCreatedAt = -Infinity;

  /** A signed event on `topic`, as JSON. `aux` is for tests. */
  async event(topic: string, content: string, createdAt: number, aux?: Uint8Array): Promise<string> {
    checkTopic(topic);
    // An event's id covers its time in seconds but not its signature, and
    // relays drop an id they have seen: so each event is at least a second
    // after this signer's last, or a message sent again within a second
    // would vanish.
    createdAt = Math.max(createdAt, this.lastCreatedAt + 1);
    this.lastCreatedAt = createdAt;
    if (!BASE64.test(content)) throw new Error("content must be base64");
    const k = kind(topic);
    const tags = [["x", topic]];
    const id = await sha256(ascii(JSON.stringify([0, this.pubkey, createdAt, k, tags, content])));
    const sig = await sign(this.secretKey, id, aux);
    return JSON.stringify({ id: toHex(id), pubkey: this.pubkey, created_at: createdAt, kind: k, tags, content, sig: toHex(sig) });
  }
}
