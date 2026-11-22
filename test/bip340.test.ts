// BIP-340's own test vectors (bip-0340/test-vectors.csv in bitcoin/bips,
// BSD-2-Clause): every row with a secret key is a signing vector. The same
// file sculk's Java tests use.
import csv from "./bip340-vectors.csv";
import { newSecretKey, publicKey, sign } from "../src/bip340";

const hex = (s: string): Uint8Array<ArrayBuffer> => new Uint8Array(s.match(/../g)?.map((b) => parseInt(b, 16)) ?? []);
const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

let signed = 0;
for (const line of csv.trim().split(/\r?\n/).slice(1)) {
  const f = line.split(",");
  if (f[1] === "") continue; // verification-only vector
  const [index, sk, pub, aux, msg, sig] = f as [string, string, string, string, string, string];
  if (toHex(publicKey(hex(sk))) !== pub.toLowerCase()) throw new Error(`public key, vector ${index}`);
  if (toHex(await sign(hex(sk), hex(msg), hex(aux))) !== sig.toLowerCase()) throw new Error(`signature, vector ${index}`);
  signed++;
}
if (signed !== 8) throw new Error(`${signed} signing vectors`);
console.log(`ok   BIP-340 signing vectors (${signed})`);

const sk = newSecretKey();
if (publicKey(sk).length !== 32 || (await sign(sk, new Uint8Array(32))).length !== 64) throw new Error("random key");
console.log("ok   a random key signs");
