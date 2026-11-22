// Connections to the Nostr relays of one topic (schlarpc/sculk's
// docs/REMOTE.md), as the game's RelayPool.java: keep `want` of them open in
// the topic's rendezvous order, publish and subscribe on all of them, and
// hand each event on once however many relays deliver it.
//
// A relay that refuses for good (blocked:, restricted:, auth-required:, pow:)
// is dropped for the next in order; one that disconnects is retried with
// backoff. Publishing is best effort: the signaling session above publishes
// again until it hears back.

import { filter } from "./nostr";

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/** What the pool needs of a WebSocket; the browser's own, or a fake in tests. */
export interface SocketLike {
  onopen: (() => void) | null;
  onmessage: ((m: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(text: string): void;
  close(): void;
}
export type SocketFactory = (url: string) => SocketLike;

const TERMINAL = /^(blocked|restricted|auth-required|pow):/;
const SEEN_MAX = 4096;
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 60_000;

interface Relay {
  url: string;
  socket: SocketLike | null;
  open: boolean;
  backoff: number;
  timer?: ReturnType<typeof setTimeout>;
}

export class RelayPool {
  private readonly active = new Map<string, Relay>();
  private readonly retired = new Set<string>();
  private readonly topics = new Set<string>();
  private readonly seen = new Set<string>();
  private closed = false;

  /**
   * @param ranked relays in the topic's rendezvous order (relaysFor)
   * @param want how many to keep open
   */
  constructor(
    private readonly ranked: readonly string[],
    private readonly want: number,
    private readonly onEvent: (e: NostrEvent) => void,
    private readonly socket: SocketFactory = (url) => new WebSocket(url) as unknown as SocketLike,
    private readonly nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    this.fill();
  }

  /** Receive events on `topic` from now on, on every relay, including ones opened later. */
  subscribe(topic: string): void {
    if (this.topics.has(topic)) return;
    this.topics.add(topic);
    for (const r of this.active.values()) if (r.open) this.sendReq(r, topic);
  }

  /** Send a signed event (Signer.event) to every open relay. */
  publish(event: string): void {
    this.remember((JSON.parse(event) as NostrEvent).id); // our own, if a relay echoes it
    const msg = `["EVENT",${event}]`;
    for (const r of this.active.values()) if (r.open) r.socket!.send(msg);
  }

  /** The relays open now. */
  get openRelays(): string[] {
    return [...this.active.values()].filter((r) => r.open).map((r) => r.url);
  }

  close(): void {
    this.closed = true;
    for (const r of this.active.values()) {
      clearTimeout(r.timer);
      r.socket?.close();
    }
    this.active.clear();
  }

  private fill(): void {
    for (const url of this.ranked) {
      if (this.active.size >= this.want) return;
      if (this.active.has(url) || this.retired.has(url)) continue;
      const r: Relay = { url, socket: null, open: false, backoff: BACKOFF_MIN_MS };
      this.active.set(url, r);
      this.connect(r);
    }
  }

  private connect(r: Relay): void {
    let s: SocketLike;
    try {
      s = this.socket(r.url);
    } catch {
      this.dropped(r);
      return;
    }
    r.socket = s;
    const mine = () => this.active.get(r.url) === r && r.socket === s;
    s.onopen = () => {
      if (!mine()) return;
      r.open = true;
      r.backoff = BACKOFF_MIN_MS;
      for (const t of this.topics) this.sendReq(r, t);
    };
    s.onmessage = (m) => {
      if (mine() && typeof m.data === "string") this.receive(r, m.data);
    };
    s.onclose = s.onerror = () => {
      if (mine()) this.dropped(r);
    };
  }

  private dropped(r: Relay): void {
    r.open = false;
    r.socket = null;
    if (this.closed) return;
    const delay = r.backoff;
    r.backoff = Math.min(r.backoff * 2, BACKOFF_MAX_MS);
    r.timer = setTimeout(() => {
      if (!this.closed && this.active.get(r.url) === r && r.socket === null) this.connect(r);
    }, delay);
  }

  private retire(r: Relay, why: string): void {
    console.info(`nostr ${r.url}: dropped (${why})`);
    this.active.delete(r.url);
    this.retired.add(r.url);
    clearTimeout(r.timer);
    r.socket?.close();
    this.fill();
  }

  private static subId(topic: string): string {
    return `sculk-${topic.slice(0, 16)}`;
  }

  private sendReq(r: Relay, topic: string): void {
    r.socket!.send(JSON.stringify(["REQ", RelayPool.subId(topic), filter(topic, this.nowSeconds())]));
  }

  private remember(id: string): void {
    this.seen.add(id);
    if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.values().next().value!);
  }

  private receive(r: Relay, text: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      return; // a relay talking nonsense is ignored, not fatal
    }
    if (!Array.isArray(msg) || msg.length === 0) return;
    switch (msg[0]) {
      case "EVENT": {
        const [, sub, event] = msg as [string, unknown, unknown];
        if (typeof event !== "object" || event === null) return;
        const e = event as Partial<NostrEvent>;
        const topic = Array.isArray(e.tags) ? e.tags.find((t) => Array.isArray(t) && t[0] === "x")?.[1] : undefined;
        if (typeof topic !== "string" || !this.topics.has(topic) || sub !== RelayPool.subId(topic)) return;
        if (typeof e.id !== "string" || this.seen.has(e.id)) return;
        this.remember(e.id);
        this.onEvent(e as NostrEvent);
        return;
      }
      case "OK": {
        // ["OK", id, accepted, message]
        if (msg.length >= 4 && msg[2] === false && typeof msg[3] === "string" && TERMINAL.test(msg[3])) {
          this.retire(r, msg[3]);
        }
        return;
      }
      case "CLOSED": {
        // ["CLOSED", subId, message]: a refused subscription
        if (typeof msg[2] === "string" && TERMINAL.test(msg[2])) this.retire(r, msg[2]);
        return;
      }
    }
  }
}
