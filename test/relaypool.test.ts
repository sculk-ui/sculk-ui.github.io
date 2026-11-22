// RelayPool against in-memory fake relays, as the game's RelayPoolTest does.
import { RelayPool, type NostrEvent, type SocketLike } from "../src/relaypool";
import { Signer } from "../src/nostr";

class FakeRelay {
  up = true;
  refuse: string | null = null;
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

class FakeSocket implements SocketLike {
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
      for (const c of this.relay.conns) for (const [sub, t] of c.subs) if (t === e.tags[0]![1]) c.deliver(JSON.stringify(["EVENT", sub, e]));
    }
  }
  close(): void {
    this.open = false;
    this.relay.conns.delete(this);
  }
}

class FakeNet {
  readonly relays = new Map<string, FakeRelay>();
  relay(url: string): FakeRelay {
    if (!this.relays.has(url)) this.relays.set(url, new FakeRelay(url));
    return this.relays.get(url)!;
  }
  readonly factory = (url: string): SocketLike => new FakeSocket(this.relay(url));
}

const TOPIC = "ab".repeat(32);
const URLS = ["wss://r1", "wss://r2", "wss://r3", "wss://r4", "wss://r5"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 10_000;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(10);
  }
}
const pool = (net: FakeNet, want: number, into: NostrEvent[] = []) =>
  new RelayPool(URLS, want, (e) => into.push(e), net.factory, () => 1_000_000);
const event = (topic = TOPIC) => new Signer().event(topic, "aGk=", 1_000_000);

let failures = 0;
async function test(name: string, f: () => Promise<void>): Promise<void> {
  try {
    await f();
    console.log(`ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}\n  ${e instanceof Error ? e.message : String(e)}`);
  }
}

await test("relay pool: delivers once through every overlapping relay", async () => {
  const net = new FakeNet();
  const got: NostrEvent[] = [];
  const game = pool(net, 5, got);
  const browser = pool(net, 3);
  game.subscribe(TOPIC);
  await until(() => game.openRelays.length === 5 && browser.openRelays.length === 3, "open");
  await sleep(20);
  browser.publish(await event());
  await until(() => got.length > 0, "delivered");
  await sleep(50);
  if (got.length !== 1) throw new Error(`${got.length} deliveries`);
  game.close();
  browser.close();
});

await test("relay pool: other topics are ignored", async () => {
  const net = new FakeNet();
  const got: NostrEvent[] = [];
  const game = pool(net, 2, got);
  const other = pool(net, 2);
  game.subscribe(TOPIC);
  other.subscribe("cd".repeat(32));
  await until(() => game.openRelays.length === 2 && other.openRelays.length === 2, "open");
  await sleep(20);
  other.publish(await event("cd".repeat(32)));
  await sleep(100);
  if (got.length !== 0) throw new Error("delivered");
  game.close();
  other.close();
});

await test("relay pool: a relay that refuses for good is replaced by the next", async () => {
  const net = new FakeNet();
  net.relay("wss://r1").refuse = "pow: difficulty 20 required";
  const p = pool(net, 2);
  await until(() => p.openRelays.length === 2, "open");
  p.publish(await event());
  await until(() => JSON.stringify(p.openRelays) === JSON.stringify(["wss://r2", "wss://r3"]), "r1 replaced by r3");
  p.close();
});

await test("relay pool: a passing refusal keeps the relay", async () => {
  const net = new FakeNet();
  net.relay("wss://r1").refuse = "rate-limited: slow down";
  const p = pool(net, 2);
  await until(() => p.openRelays.length === 2, "open");
  p.publish(await event());
  await sleep(100);
  if (JSON.stringify(p.openRelays) !== JSON.stringify(["wss://r1", "wss://r2"])) throw new Error(String(p.openRelays));
  p.close();
});

await test("relay pool: a relay that drops is retried and resubscribed", async () => {
  const net = new FakeNet();
  const got: NostrEvent[] = [];
  const p = pool(net, 1, got);
  const sender = pool(net, 1);
  p.subscribe(TOPIC);
  const r1 = net.relay("wss://r1");
  await until(() => [...r1.conns].some((c) => c.subs.size > 0), "subscribed");
  r1.up = false;
  r1.bounce();
  await until(() => p.openRelays.length === 0, "noticed");
  r1.up = true;
  await until(() => [...r1.conns].some((c) => c.subs.size > 0), "reconnected and resubscribed");
  await until(() => sender.openRelays.length === 1, "sender open");
  sender.publish(await event());
  await until(() => got.length > 0, "delivered after the reconnect");
  p.close();
  sender.close();
});

await test("relay pool: nonsense from a relay is ignored", async () => {
  const net = new FakeNet();
  const p = pool(net, 1);
  p.subscribe(TOPIC);
  await until(() => p.openRelays.length === 1, "open");
  const conn = [...net.relay("wss://r1").conns][0]!;
  for (const junk of ["", "{}", "[]", "[1,2]", '["EVENT"]', '["EVENT","x",{}]', '["OK"]', '["EVENT","x",null]']) conn.onmessage?.({ data: junk });
  await sleep(20);
  if (p.openRelays.length !== 1) throw new Error("dropped");
  p.close();
});

if (failures > 0) throw new Error(`${failures} failed`);
