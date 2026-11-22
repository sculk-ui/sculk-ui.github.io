// TunnelClient against a fake game speaking Tunnel.java's messages.
import { type Pipe, TunnelClient } from "../src/tunnel";

const REQUEST = 1, REQUEST_BODY = 2, REQUEST_END = 3, CANCEL = 7;
const RESPONSE = 4, RESPONSE_BODY = 5, RESPONSE_END = 6, ERROR = 8;
const utf8 = (s: string) => new TextEncoder().encode(s);

function msg(stream: number, type: number, data: Uint8Array = new Uint8Array(0)): Uint8Array {
  const out = new Uint8Array(5 + data.length);
  new DataView(out.buffer).setUint32(0, stream, false);
  out[4] = type;
  out.set(data, 5);
  return out;
}

/** A pipe whose far end is `game`, called with each message the client sends. */
function fakeGame(game: (m: { stream: number; type: number; data: Uint8Array }, reply: (m: Uint8Array) => void) => void) {
  let handler: (m: Uint8Array) => void = () => {};
  const sent: number[] = [];
  const pipe: Pipe = {
    send: (m) => {
      const stream = new DataView(m.buffer, m.byteOffset).getUint32(0, false);
      sent.push(m[4]!);
      queueMicrotask(() => game({ stream, type: m[4]!, data: m.slice(5) }, (r) => queueMicrotask(() => handler(r))));
    },
    onMessage: (h) => (handler = h),
  };
  return { pipe, sent };
}

/** A game that answers each request with its method, path and body, as JSON. */
function echoGame() {
  const bodies = new Map<number, { head: string; body: string }>();
  return fakeGame(({ stream, type, data }, reply) => {
    if (type === REQUEST) bodies.set(stream, { head: new TextDecoder().decode(data), body: "" });
    if (type === REQUEST_BODY) bodies.get(stream)!.body += new TextDecoder().decode(data);
    if (type === REQUEST_END) {
      const r = bodies.get(stream)!;
      reply(msg(stream, RESPONSE, utf8(JSON.stringify({ status: 200, headers: { "content-type": "application/json" } }))));
      reply(msg(stream, RESPONSE_BODY, utf8(JSON.stringify({ head: JSON.parse(r.head), body: r.body }))));
      reply(msg(stream, RESPONSE_END));
    }
  });
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

await test("tunnel: a request and its answer", async () => {
  const client = new TunnelClient(echoGame().pipe);
  const r = await client.fetch("/api/eval", { method: "POST", body: "x".repeat(40_000), headers: { Accept: "application/json" } });
  if (r.status !== 200 || r.headers.get("content-type") !== "application/json") throw new Error(`${r.status}`);
  const j = (await r.json()) as { head: { method: string; path: string; headers: Record<string, string> }; body: string };
  if (j.head.method !== "POST" || j.head.path !== "/api/eval" || j.head.headers.accept !== "application/json") throw new Error(JSON.stringify(j.head));
  if (j.body.length !== 40_000) throw new Error(`body ${j.body.length}`);
});

await test("tunnel: a body arrives in pieces, as written", async () => {
  const { pipe } = fakeGame(({ stream, type }, reply) => {
    if (type !== REQUEST_END) return;
    reply(msg(stream, RESPONSE, utf8('{"status":200,"headers":{"content-type":"text/event-stream"}}')));
    reply(msg(stream, RESPONSE_BODY, utf8("data: 1\n\n")));
    setTimeout(() => {
      reply(msg(stream, RESPONSE_BODY, utf8("data: 2\n\n")));
      reply(msg(stream, RESPONSE_END));
    }, 20);
  });
  const r = await new TunnelClient(pipe).fetch("/api/events/stream");
  const reader = r.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  if (first !== "data: 1\n\n") throw new Error(first);
  const second = new TextDecoder().decode((await reader.read()).value);
  if (second !== "data: 2\n\n" || !(await reader.read()).done) throw new Error(second);
});

await test("tunnel: no body for 204", async () => {
  const { pipe } = fakeGame(({ stream, type }, reply) => {
    if (type === REQUEST_END) {
      reply(msg(stream, RESPONSE, utf8('{"status":204}')));
      reply(msg(stream, RESPONSE_END));
    }
  });
  const r = await new TunnelClient(pipe).fetch("/api/x");
  if (r.status !== 204 || r.body !== null) throw new Error(String(r.status));
});

await test("tunnel: the game's error fails the fetch, as a network error", async () => {
  const { pipe } = fakeGame(({ stream, type }, reply) => {
    if (type === REQUEST_END) reply(msg(stream, ERROR, utf8("the control server is off")));
  });
  try {
    await new TunnelClient(pipe).fetch("/api/status");
  } catch (e) {
    if (!(e instanceof TypeError) || !e.message.includes("control server is off")) throw e;
    return;
  }
  throw new Error("did not fail");
});

await test("tunnel: aborting sends a cancel", async () => {
  const { pipe, sent } = fakeGame(({ stream, type }, reply) => {
    if (type === REQUEST_END) reply(msg(stream, RESPONSE, utf8('{"status":200}')));
  });
  const abort = new AbortController();
  const r = await new TunnelClient(pipe).fetch("/api/events/stream", { signal: abort.signal });
  const reading = r.body!.getReader().read();
  abort.abort();
  try {
    await reading;
  } catch {
    // aborted, as fetch's body would be
  }
  await new Promise((res) => setTimeout(res, 10));
  if (!sent.includes(CANCEL)) throw new Error(`sent ${sent}`);
});

await test("tunnel: closing fails what is in flight", async () => {
  const { pipe } = fakeGame(() => {});
  const client = new TunnelClient(pipe);
  const pending = client.fetch("/api/status");
  await new Promise((res) => setTimeout(res, 5));
  client.close();
  try {
    await pending;
  } catch (e) {
    if (e instanceof TypeError) return;
    throw e;
  }
  throw new Error("did not fail");
});

void REQUEST_BODY;
if (failures > 0) throw new Error(`${failures} failed`);
