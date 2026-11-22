// BIP-340 Schnorr signing on secp256k1, which Nostr requires on every event;
// WebCrypto has no secp256k1. Signing only: relays check signatures, and
// nothing the shell trusts depends on them (Noise does, inside the events).
//
// Not constant-time. That is acceptable because the keys are throwaway: one
// per signaling session, never stored, protecting nothing. Do not use this
// for a key that matters. sculk's Java side is core/.../remote/Bip340.java.

import type { Bytes } from "./noise";

const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;

const mod = (a: bigint, m = P): bigint => {
  const r = a % m;
  return r < 0n ? r + m : r;
};

function modPow(b: bigint, e: bigint, m: bigint): bigint {
  let r = 1n;
  b = mod(b, m);
  for (; e > 0n; e >>= 1n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
  }
  return r;
}

/** Jacobian coordinates (x = X/Z², y = Y/Z³); z = 0 is infinity. */
interface Point {
  x: bigint;
  y: bigint;
  z: bigint;
}
const INF: Point = { x: 1n, y: 1n, z: 0n };
const G: Point = { x: GX, y: GY, z: 1n };

function twice(p: Point): Point {
  if (p.z === 0n || p.y === 0n) return INF;
  const y2 = mod(p.y * p.y);
  const s = mod(4n * p.x * y2);
  const m = mod(3n * p.x * p.x); // a = 0
  const x3 = mod(m * m - 2n * s);
  return { x: x3, y: mod(m * (s - x3) - 8n * y2 * y2), z: mod(2n * p.y * p.z) };
}

function plus(a: Point, b: Point): Point {
  if (a.z === 0n) return b;
  if (b.z === 0n) return a;
  const z1z1 = mod(a.z * a.z);
  const z2z2 = mod(b.z * b.z);
  const u1 = mod(a.x * z2z2);
  const u2 = mod(b.x * z1z1);
  const s1 = mod(a.y * b.z * z2z2);
  const s2 = mod(b.y * a.z * z1z1);
  if (u1 === u2) return s1 === s2 ? twice(a) : INF;
  const h = mod(u2 - u1);
  const r = mod(s2 - s1);
  const h2 = mod(h * h);
  const h3 = mod(h2 * h);
  const u1h2 = mod(u1 * h2);
  const x3 = mod(r * r - h3 - 2n * u1h2);
  return { x: x3, y: mod(r * (u1h2 - x3) - s1 * h3), z: mod(h * a.z * b.z) };
}

function mul(p: Point, k: bigint): Point {
  let r = INF;
  for (let i = BigInt(k.toString(2).length) - 1n; i >= 0n; i--) {
    r = twice(r);
    if ((k >> i) & 1n) r = plus(r, p);
  }
  return r;
}

function affine(p: Point): [bigint, bigint] {
  if (p.z === 0n) throw new Error("point at infinity");
  const zi = modPow(p.z, P - 2n, P);
  const zi2 = mod(zi * zi);
  return [mod(p.x * zi2), mod(p.y * zi2 * zi)];
}

const toInt = (b: Uint8Array): bigint => b.reduce((n, x) => (n << 8n) | BigInt(x), 0n);

/** 32 bytes, big-endian. */
function bytes(n: bigint): Bytes {
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

async function taggedHash(tag: string, ...parts: Uint8Array[]): Promise<Bytes> {
  const th = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tag)));
  const all = new Uint8Array(64 + parts.reduce((n, p) => n + p.length, 0));
  all.set(th, 0);
  all.set(th, 32);
  let at = 64;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", all));
}

function secret(sk: Uint8Array): bigint {
  if (sk.length !== 32) throw new Error(`secret key: ${sk.length} bytes`);
  const d = toInt(sk);
  if (d === 0n || d >= N) throw new Error("secret key out of range");
  return d;
}

/** A new random secret key. */
export function newSecretKey(): Bytes {
  for (;;) {
    const sk = crypto.getRandomValues(new Uint8Array(32));
    const d = toInt(sk);
    if (d > 0n && d < N) return sk;
  }
}

/** The 32-byte x-only public key. */
export function publicKey(sk: Uint8Array): Bytes {
  return bytes(affine(mul(G, secret(sk)))[0]);
}

/** BIP-340's Sign; `aux` is 32 bytes of randomness, fresh unless testing. */
export async function sign(
  sk: Uint8Array,
  msg: Uint8Array,
  aux: Uint8Array = crypto.getRandomValues(new Uint8Array(32)),
): Promise<Bytes> {
  if (aux.length !== 32) throw new Error(`aux: ${aux.length} bytes`);
  const d0 = secret(sk);
  const [px, py] = affine(mul(G, d0));
  const d = py & 1n ? N - d0 : d0;
  const pxb = bytes(px);

  const t = bytes(d);
  const auxHash = await taggedHash("BIP0340/aux", aux);
  for (let i = 0; i < 32; i++) t[i]! ^= auxHash[i]!;
  const k0 = toInt(await taggedHash("BIP0340/nonce", t, pxb, msg)) % N;
  if (k0 === 0n) throw new Error("BIP-340: zero nonce"); // negligible
  const [rx, ry] = affine(mul(G, k0));
  const k = ry & 1n ? N - k0 : k0;
  const rxb = bytes(rx);
  const e = toInt(await taggedHash("BIP0340/challenge", rxb, pxb, msg)) % N;

  const sig = new Uint8Array(64);
  sig.set(rxb, 0);
  sig.set(bytes(mod(k + e * d, N)), 32);
  return sig;
}
