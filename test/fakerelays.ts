// In-memory Nostr relays for tests: each forwards EVENTs to subscriptions on
// the event's x tag, as the game's FakeRelays.java.
import type { NostrEvent, SocketLike } from "../src/relaypool";

export class FakeRelay {
  up = true;
  refuse: string | null = null;
  /** When true, half the EVENTs, at random, are accepted and then lost. */
  lossy = false;
  readonly conns = new Set<FakeSocket>();
  readonly received: string[] = [];
  constructor(readonly url: string) {}
  bounce(): void {
    for (const c of [...this.conns]) {
      this.conns.delete(c);
      c.open = false;
      c.onclose?.();
    }
  }
}

export class FakeSocket implements SocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  open = true;
  readonly subs = new Map<string, string>(); // subId -> topic
  constructor(readonly relay: FakeRelay) {
    setTimeout(() => {
      if (!relay.up) {
        this.open = false;
        this.onclose?.();
        return;
      }
      relay.conns.add(this);
      this.onopen?.();
    }, 1);
  }
  deliver(text: string): void {
    setTimeout(() => this.open && this.onmessage?.({ data: text }), 1);
  }
  send(text: string): void {
    if (!this.open) return;
    const msg = JSON.parse(text);
    if (msg[0] === "REQ") {
      this.subs.set(msg[1], msg[2]["#x"][0]);
      this.deliver(JSON.stringify(["EOSE", msg[1]]));
    } else if (msg[0] === "EVENT") {
      const e = msg[1] as NostrEvent;
      if (this.relay.refuse) return this.deliver(JSON.stringify(["OK", e.id, false, this.relay.refuse]));
      this.relay.received.push(e.id);
      this.deliver(JSON.stringify(["OK", e.id, true, ""]));
      if (this.relay.lossy && Math.random() < 0.5) return;
      for (const c of this.relay.conns) for (const [sub, t] of c.subs) if (t === e.tags[0]![1]) c.deliver(JSON.stringify(["EVENT", sub, e]));
    }
  }
  close(): void {
    this.open = false;
    this.relay.conns.delete(this);
  }
}

export class FakeNet {
  readonly relays = new Map<string, FakeRelay>();
  relay(url: string): FakeRelay {
    if (!this.relays.has(url)) this.relays.set(url, new FakeRelay(url));
    return this.relays.get(url)!;
  }
  readonly factory = (url: string): SocketLike => new FakeSocket(this.relay(url));
}
