// BrowserSignaling against a small game built from the same pieces, through
// fake relays, as the game's GameSignalingTest does the other way round.
import { type Bytes, NoiseXK, type Transport, generateKeyPair } from "../src/noise";
import { Signer, relaysFor, serverTopic } from "../src/nostr";
import { RelayPool } from "../src/relaypool";
import { BrowserSignaling, type Status, approvalCode, decodeEnvelope, encodeEnvelope, prologue } from "../src/signaling";
import { FakeNet } from "./fakerelays";

const RELAYS = Array.from({ length: 12 }, (_, i) => `wss://r${i}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (s: string): Bytes => new Uint8Array(s.match(/../g)!.map((b) => parseInt(b, 16)));
const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const utf8 = (s: string) => new TextEncoder().encode(s) as Bytes;

/** The game's side, minimal: verdict decides what it answers after message 3. */
async function miniGame(net: FakeNet, verdict: "approve" | "pend-then-approve" | "deny") {
  const key = await generateKeyPair();
  const topic = await serverTopic(key.pub);
  const signer = new Signer();
  const sessions = new Map<string, { noise: NoiseXK; t?: Transport; nextIn: number; nextOut: number; last: string }>();
  const seenKeys: string[] = [];
  const codes: string[] = [];
  let queue = Promise.resolve();
  const publish = async (sidHex: string, s: { last: string }) =>
    pool.publish(await signer.event(sidHex, s.last, Math.floor(Date.now() / 1000)));
  const send = async (sid: Bytes, s: { nextOut: number; last: string }, body: Bytes) => {
    s.last = encodeEnvelope({ sid, n: s.nextOut++, body });
    await publish(toHex(sid), s);
  };
  const status = async (sid: Bytes, s: { t?: Transport; nextOut: number; last: string }, json: object) =>
    send(sid, s, await s.t!.send.encrypt(new Uint8Array(0), utf8(JSON.stringify(json))));
  const pool = new RelayPool(await relaysFor(topic, RELAYS), 8, (e) => {
    queue = queue.then(async () => {
      const env = decodeEnvelope(e.content);
      const sidHex = toHex(env.sid);
      let s = sessions.get(sidHex);
      if (!s) {
        if (env.n !== 0) return;
        s = { noise: await NoiseXK.responder(key, prologue(env.sid)), nextIn: 0, nextOut: 0, last: "" };
        sessions.set(sidHex, s);
      }
      // The browser sent its latest again: so may we (this game has no timer).
      if (env.n === s.nextIn - 1 && s.last) return publish(sidHex, s);
      if (env.n !== s.nextIn) return;
      s.nextIn++;
      if (env.n === 0) {
        await s.noise.readMessage(env.body);
        await send(env.sid, s, await s.noise.writeMessage(new Uint8Array(0)));
      } else if (env.n === 1) {
        const offer = JSON.parse(new TextDecoder().decode(await s.noise.readMessage(env.body))).sdp;
        s.t = await s.noise.split();
        seenKeys.push(toHex(s.noise.remoteStatic!));
        codes.push(await approvalCode(s.t.secret));
        if (verdict === "deny") return status(env.sid, s, { status: "denied" });
        if (verdict === "pend-then-approve") {
          await status(env.sid, s, { status: "pending" });
          await sleep(100);
        }
        await status(env.sid, s, { status: "approved", sdp: `ANSWER to ${offer}` });
      }
    });
  }, net.factory);
  pool.subscribe(topic);
  return { key, pool, seenKeys, codes };
}

async function browser(net: FakeNet, serverKey: Bytes, statuses: Status[]) {
  const staticKey = await generateKeyPair();
  const b = await BrowserSignaling.start({ serverKey, staticKey, offer: "OFFER", relays: RELAYS, onStatus: (s) => statuses.push(s), socket: net.factory });
  return { b, staticKey };
}

async function until(cond: () => boolean, what: string, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(10);
  }
}

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

await test("signaling: the approval code matches the game's", async () => {
  // The same code for the same 32 bytes is pinned in Java.
  const code = await approvalCode(hex("4f5a40e425d3adcdb2c715d988e4ef8763ed0f8aa0fe78e2d2879d71b2d38186"));
  if (code !== "144909") throw new Error(code);
});

await test("signaling: approved at once", async () => {
  const net = new FakeNet();
  const game = await miniGame(net, "approve");
  const got: Status[] = [];
  const { b, staticKey } = await browser(net, game.key.pub, got);
  await until(() => got.length > 0, "a verdict");
  const s = got[0]!;
  if (s.status !== "approved" || s.sdp !== "ANSWER to OFFER") throw new Error(JSON.stringify(s));
  if (game.seenKeys[0] !== toHex(staticKey.pub)) throw new Error("the game saw another key");
  if (s.code !== game.codes[0]) throw new Error(`codes differ: ${s.code} ${game.codes[0]}`);
  b.close();
  game.pool.close();
});

await test("signaling: pending, then approved", async () => {
  const net = new FakeNet();
  const game = await miniGame(net, "pend-then-approve");
  const got: Status[] = [];
  const { b } = await browser(net, game.key.pub, got);
  await until(() => got.length >= 2, "two verdicts");
  if (got.map((s) => s.status).join() !== "pending,approved") throw new Error(JSON.stringify(got));
  b.close();
  game.pool.close();
});

await test("signaling: denied", async () => {
  const net = new FakeNet();
  const game = await miniGame(net, "deny");
  const got: Status[] = [];
  const { b } = await browser(net, game.key.pub, got);
  await until(() => got.length > 0, "a verdict");
  if (got[0]!.status !== "denied") throw new Error(JSON.stringify(got));
  b.close();
  game.pool.close();
});

await test("signaling: lost messages are sent again", async () => {
  const net = new FakeNet();
  for (const r of RELAYS) net.relay(r).lossy = true;
  const game = await miniGame(net, "approve");
  const got: Status[] = [];
  const { b } = await browser(net, game.key.pub, got);
  await until(() => got.length > 0, "a verdict", 30_000);
  if (got[0]!.status !== "approved") throw new Error(JSON.stringify(got));
  b.close();
  game.pool.close();
});

if (failures > 0) throw new Error(`${failures} failed`);
