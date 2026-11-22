// Noise XK against the published vectors, the same file sculk's Java tests
// use, plus the failures that matter. Run by `nix flake check` under Node,
// whose WebCrypto has X25519 as browsers do.
import vectorFile from "./noise-vectors.json";
import { type Bytes, NoiseXK, generateKeyPair, keyPairFromPrivate } from "../src/noise";

interface Vector {
  source: string;
  init_prologue: string;
  init_static: string;
  init_ephemeral: string;
  init_remote_static: string;
  resp_static: string;
  resp_ephemeral: string;
  handshake_hash?: string;
  messages: { payload: string; ciphertext: string }[];
}

const hex = (s: string): Bytes => new Uint8Array(s.match(/../g)?.map((b) => parseInt(b, 16)) ?? []);
const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

let failures = 0;
function equal(want: Uint8Array, got: Uint8Array, what: string): void {
  if (toHex(want) !== toHex(got)) throw new Error(`${what}:\n  want ${toHex(want)}\n  got  ${toHex(got)}`);
}
async function rejects(f: () => Promise<unknown>, what: string): Promise<void> {
  try {
    await f();
  } catch {
    return;
  }
  throw new Error(`${what}: did not fail`);
}
async function test(name: string, f: () => Promise<void>): Promise<void> {
  try {
    await f();
    console.log(`ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}\n  ${e instanceof Error ? e.message : String(e)}`);
  }
}

await test("published vectors", async () => {
  const vectors = (vectorFile as { vectors: Vector[] }).vectors;
  if (vectors.length !== 2) throw new Error(`${vectors.length} vectors`);
  for (const v of vectors) {
    const prologue = hex(v.init_prologue);
    const initE = await keyPairFromPrivate(hex(v.init_ephemeral));
    const respE = await keyPairFromPrivate(hex(v.resp_ephemeral));
    const initS = await keyPairFromPrivate(hex(v.init_static));
    const init = await NoiseXK.initiator(initS, hex(v.init_remote_static), prologue, async () => initE);
    const resp = await NoiseXK.responder(await keyPairFromPrivate(hex(v.resp_static)), prologue, async () => respE);
    let it, rt;
    for (const [i, m] of v.messages.entries()) {
      const fromInit = i % 2 === 0;
      let wire: Bytes, got: Bytes;
      if (i < 3) {
        wire = await (fromInit ? init : resp).writeMessage(hex(m.payload));
        equal(hex(m.ciphertext), wire, `${v.source}: handshake message ${i}`);
        got = await (fromInit ? resp : init).readMessage(wire);
      } else {
        it ??= await init.split();
        rt ??= await resp.split();
        wire = await (fromInit ? it : rt).send.encrypt(new Uint8Array(0), hex(m.payload));
        equal(hex(m.ciphertext), wire, `${v.source}: transport message ${i}`);
        got = await (fromInit ? rt : it).receive.decrypt(new Uint8Array(0), wire);
      }
      equal(hex(m.payload), got, `${v.source}: payload ${i}`);
    }
    if (v.handshake_hash !== undefined) equal(hex(v.handshake_hash), init.handshakeHash, v.source);
    equal(init.handshakeHash, resp.handshakeHash, v.source);
    equal(initS.pub, resp.remoteStatic!, `${v.source}: the responder learns the initiator's key`);
  }
});

await test("a non-extractable static key works", async () => {
  const server = await generateKeyPair();
  const browser = await generateKeyPair(false);
  if (browser.priv.extractable) throw new Error("extractable");
  const init = await NoiseXK.initiator(browser, server.pub, new Uint8Array(0));
  const resp = await NoiseXK.responder(server, new Uint8Array(0));
  await resp.readMessage(await init.writeMessage(new Uint8Array(0)));
  await init.readMessage(await resp.writeMessage(new Uint8Array(0)));
  await resp.readMessage(await init.writeMessage(new Uint8Array(0)));
  equal(browser.pub, resp.remoteStatic!, "remote static");
});

await test("the wrong server key fails at the first message", async () => {
  const server = await generateKeyPair();
  const other = await generateKeyPair();
  const init = await NoiseXK.initiator(await generateKeyPair(), other.pub, new Uint8Array(0));
  const resp = await NoiseXK.responder(server, new Uint8Array(0));
  const m1 = await init.writeMessage(new Uint8Array(0));
  await rejects(() => resp.readMessage(m1), "read");
});

await test("prologues must match", async () => {
  const server = await generateKeyPair();
  const init = await NoiseXK.initiator(await generateKeyPair(), server.pub, new Uint8Array([1]));
  const resp = await NoiseXK.responder(server, new Uint8Array([2]));
  const m1 = await init.writeMessage(new Uint8Array(0));
  await rejects(() => resp.readMessage(m1), "read");
});

await test("a tampered message fails", async () => {
  const server = await generateKeyPair();
  const init = await NoiseXK.initiator(await generateKeyPair(), server.pub, new Uint8Array(0));
  const resp = await NoiseXK.responder(server, new Uint8Array(0));
  await resp.readMessage(await init.writeMessage(new TextEncoder().encode("hi") as Bytes));
  const m2 = await resp.writeMessage(new Uint8Array(0));
  m2[40]! ^= 1;
  await rejects(() => init.readMessage(m2), "read");
});

await test("small-order keys are refused", async () => {
  for (const u of [0, 1]) {
    const bad = new Uint8Array(32);
    bad[0] = u;
    const init = await NoiseXK.initiator(await generateKeyPair(), bad, new Uint8Array(0));
    await rejects(() => init.writeMessage(new Uint8Array(0)), `u=${u}`);
  }
});

await test("turns are enforced", async () => {
  const server = await generateKeyPair();
  const init = await NoiseXK.initiator(await generateKeyPair(), server.pub, new Uint8Array(0));
  const resp = await NoiseXK.responder(server, new Uint8Array(0));
  if (!init.ourTurn || resp.ourTurn) throw new Error("turns");
  await rejects(() => resp.writeMessage(new Uint8Array(0)), "responder writes first");
  await rejects(() => init.split(), "split before the end");
});

if (failures > 0) throw new Error(`${failures} failed`);
