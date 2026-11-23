// The browser's side of remote access signaling (schlarpc/sculk's
// docs/REMOTE.md; the game's side is GameSignaling.java): a Noise XK
// handshake with the game in Nostr events, carrying a WebRTC offer, then the
// game's verdict: pending (the page then shows the code to type in game),
// approved (with its answer), denied or expired.

import { type Bytes, type KeyPair, NoiseXK, type Transport } from "./noise";
import { BROWSER_RELAYS, Signer, relaysFor, serverTopic } from "./nostr";
import { RelayPool, type SocketFactory } from "./relaypool";

const SID = 32;

/**
 * The Noise prologue: "sculk remote v1" || sid. With the sid in it, a first
 * message someone recorded opens no session under another sid.
 */
export function prologue(sid: Bytes): Bytes {
  const tag = new TextEncoder().encode("sculk remote v1");
  const out = new Uint8Array(tag.length + SID);
  out.set(tag, 0);
  out.set(sid, tag.length);
  return out;
}
/** Publish the latest message again this often until the game answers. */
export const RESEND_MS = 3000;

const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

function toBase64(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

function fromBase64(s: string): Bytes {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** `sid || n || body`: one message, in an event's content. */
export interface Envelope {
  sid: Bytes;
  n: number;
  body: Bytes;
}

export function encodeEnvelope(e: Envelope): string {
  const out = new Uint8Array(SID + 1 + e.body.length);
  out.set(e.sid, 0);
  out[SID] = e.n;
  out.set(e.body, SID + 1);
  return toBase64(out);
}

export function decodeEnvelope(content: string): Envelope {
  const b = fromBase64(content);
  if (b.length < SID + 1) throw new Error("short envelope");
  return { sid: b.slice(0, SID), n: b[SID]!, body: b.slice(SID + 1) };
}

/**
 * The six-digit code this page shows and the player types in game:
 * SHA-256("sculk/v1/code" || secret), first four bytes, mod 10^6, where
 * secret is the session's (Transport.secret). Nobody else can compute it, so
 * nobody else can show it.
 */
export async function approvalCode(secret: Bytes): Promise<string> {
  const tag = new TextEncoder().encode("sculk/v1/code");
  const all = new Uint8Array(tag.length + secret.length);
  all.set(tag, 0);
  all.set(secret, tag.length);
  const d = new DataView(await crypto.subtle.digest("SHA-256", all));
  return String(d.getUint32(0, false) % 1_000_000).padStart(6, "0");
}

export type Status =
  | { status: "pending"; code: string }
  | { status: "approved"; code: string; sdp: string }
  | { status: "denied" }
  | { status: "expired" };

export interface Options {
  /** The game's key, from the link. */
  serverKey: Bytes;
  /** The browser's own static key. */
  staticKey: KeyPair;
  /** A complete WebRTC offer (ICE gathering finished). */
  offer: string;
  /** The relay list (RELAYS). */
  relays: readonly string[];
  /** Called for each verdict, in order. */
  onStatus: (s: Status) => void;
  socket?: SocketFactory;
}

/** One attempt to reach a game. Close it when done. */
export class BrowserSignaling {
  readonly sid: Bytes = crypto.getRandomValues(new Uint8Array(SID));
  readonly sidHex = toHex(this.sid);
  private pool!: RelayPool;
  private noise!: NoiseXK;
  private transport: Transport | null = null;
  private topic = "";
  private readonly signer = new Signer();
  private nextIn = 0;
  private nextOut = 0;
  private lastContent = "";
  private resend: ReturnType<typeof setInterval> | undefined;
  private code = "";
  private closed = false;
  // Events are handled one at a time, in order: Noise is a sequence.
  private queue: Promise<void> = Promise.resolve();
  private readonly held = new Map<number, Bytes>();

  private constructor(private readonly opts: Options) {}

  static async start(opts: Options): Promise<BrowserSignaling> {
    const s = new BrowserSignaling(opts);
    s.topic = await serverTopic(opts.serverKey);
    s.noise = await NoiseXK.initiator(opts.staticKey, opts.serverKey, prologue(s.sid));
    const ranked = await relaysFor(s.topic, opts.relays);
    s.pool = new RelayPool(ranked, BROWSER_RELAYS, (e) => s.onContent(e.content), opts.socket);
    s.pool.subscribe(s.sidHex);
    await s.send(await s.noise.writeMessage(new Uint8Array(0)));
    return s;
  }

  /** The relays open now. */
  get openRelays(): string[] {
    return this.pool.openRelays;
  }

  close(): void {
    this.closed = true;
    clearInterval(this.resend);
    this.pool?.close();
  }

  private async send(body: Bytes): Promise<void> {
    clearInterval(this.resend);
    this.lastContent = encodeEnvelope({ sid: this.sid, n: this.nextOut++, body });
    await this.publish();
    this.resend = setInterval(() => void this.publish(), RESEND_MS);
  }

  private async publish(): Promise<void> {
    if (this.closed) return;
    // A new event each time: relays drop an event id they have seen.
    this.pool.publish(await this.signer.event(this.topic, this.lastContent, Math.floor(Date.now() / 1000)));
  }

  private onContent(content: string): void {
    this.queue = this.queue.then(() => this.receive(content)).catch(() => {
      // Not from the game holding the key, or not well formed: ignore it.
    });
  }

  private async receive(content: string): Promise<void> {
    if (this.closed) return;
    const env = decodeEnvelope(content);
    if (toHex(env.sid) !== this.sidHex || env.n < this.nextIn) return;
    if (env.n > this.nextIn) {
      // The latest copy: an earlier one may have been someone else's.
      if (env.n - this.nextIn <= 4) this.held.set(env.n, env.body);
      return;
    }
    // The sid and n are in the clear, so anyone watching can send a false
    // message for this session. handle() rejects one and changes nothing,
    // and the real one, sent again, is still read.
    let body: Bytes | undefined = env.body;
    while (body !== undefined && !this.closed) {
      await this.handle(this.nextIn, body);
      this.nextIn++;
      body = this.held.get(this.nextIn);
      this.held.delete(this.nextIn);
    }
  }

  private async handle(n: number, body: Bytes): Promise<void> {
    if (n === 0) {
      // Noise message 2; answer with message 3, carrying the offer.
      await this.noise.readMessage(body);
      const payload = new TextEncoder().encode(JSON.stringify({ sdp: this.opts.offer })) as Bytes;
      const m3 = await this.noise.writeMessage(payload);
      this.transport = await this.noise.split();
      this.code = await approvalCode(this.transport.secret);
      await this.send(m3);
      return;
    }
    const text = new TextDecoder().decode(await this.transport!.receive.decrypt(new Uint8Array(0), body));
    // A verdict from the game: it has message 3, so stop sending it.
    clearInterval(this.resend);
    const v = JSON.parse(text) as { status?: unknown; sdp?: unknown };
    switch (v.status) {
      case "pending":
        this.opts.onStatus({ status: "pending", code: this.code });
        break;
      case "approved":
        if (typeof v.sdp !== "string") throw new Error("approved without an answer");
        this.opts.onStatus({ status: "approved", code: this.code, sdp: v.sdp });
        break;
      case "denied":
      case "expired":
        this.opts.onStatus({ status: v.status });
        break;
    }
  }
}
