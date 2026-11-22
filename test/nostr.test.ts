// Against nostr-vectors.json, generated from the game's Nostr.java, so the
// two sides agree. Its event was also checked outside both (NIP-01's
// serialization in Python, BIP-340's reference.py).
import v from "./nostr-vectors.json";
import { Signer, filter, kind, relaysFor, serverTopic } from "../src/nostr";

const hex = (s: string): Uint8Array<ArrayBuffer> => new Uint8Array(s.match(/../g)?.map((b) => parseInt(b, 16)) ?? []);
function equal(want: unknown, got: unknown, what: string): void {
  if (JSON.stringify(want) !== JSON.stringify(got)) throw new Error(`${what}:\n  want ${JSON.stringify(want)}\n  got  ${JSON.stringify(got)}`);
}

const topic = await serverTopic(hex(v.serverKey));
equal(v.serverTopic, topic, "server topic");
equal(v.kind, kind(topic), "kind");
equal(v.filter, filter(topic, v.filterSince), "filter");
equal(v.relaysForServerTopic, await relaysFor(topic, v.relays), "relay order");
const e = v.event;
equal(e.json, await new Signer(hex(e.secretKey)).event(e.topic, e.content, e.createdAt, hex(e.aux)), "event");
console.log("ok   Nostr vectors shared with the game");

let refused = false;
try {
  await new Signer().event(topic, '"}', 0);
} catch {
  refused = true;
}
if (!refused) throw new Error("non-base64 content accepted");
console.log("ok   content must be base64");
