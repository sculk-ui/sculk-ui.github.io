// The sandboxed frame's loader (frame.html, built inline under its own CSP).
// The shell gives it a MessagePort that leads to the game's data channel;
// through it, this fetches the game's own web UI (index.html, its styles,
// fonts and script) and installs it here, with sculkEmbedding.fetch as the
// UI's only way to reach anything.
//
// The frame is sandboxed without allow-same-origin, so this document has an
// opaque origin: whatever the game's UI does, it cannot touch the shell's
// keys or storage, nor reach other games. Its CSP allows no connections and
// no scripts but this one and the blob: URLs it makes.

import { type Pipe, TunnelClient } from "./tunnel";

function portPipe(port: MessagePort): Pipe {
  return {
    send: (m) => port.postMessage(m, [m.buffer]),
    onMessage: (handler) => {
      port.onmessage = (e: MessageEvent) => handler(new Uint8Array(e.data as ArrayBuffer));
    },
  };
}

async function blobUrl(tunnel: TunnelClient, path: string, type?: string): Promise<string> {
  const r = await tunnel.fetch(path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  const bytes = await r.arrayBuffer();
  return URL.createObjectURL(new Blob([bytes], { type: type ?? r.headers.get("content-type") ?? "" }));
}

/** A stylesheet with its url(...) references fetched and made blob: URLs. */
async function stylesheet(tunnel: TunnelClient, path: string): Promise<string> {
  const css = await (await tunnel.fetch(path)).text();
  const refs = [...new Set([...css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((m) => m[1]!))];
  let out = css;
  for (const ref of refs) {
    if (/^(data|blob):/.test(ref)) continue;
    const target = new URL(ref, new URL(path, "https://game/")).pathname;
    out = out.split(ref).join(await blobUrl(tunnel, target));
  }
  return out;
}

async function load(port: MessagePort): Promise<void> {
  const tunnel = new TunnelClient(portPipe(port));
  (globalThis as { sculkEmbedding?: unknown }).sculkEmbedding = { fetch: (input: string, init: RequestInit) => tunnel.fetch(input, init) };

  const index = await (await tunnel.fetch("/")).text();
  const doc = new DOMParser().parseFromString(index, "text/html");
  document.title = doc.title;
  for (const meta of doc.head.querySelectorAll("meta[name]")) document.head.append(document.importNode(meta, true));
  for (const link of doc.head.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href]')) {
    const style = document.createElement("style");
    style.textContent = await stylesheet(tunnel, link.getAttribute("href")!);
    document.head.append(style);
  }
  document.body.replaceWith(document.importNode(doc.body, true));
  for (const script of doc.head.querySelectorAll<HTMLScriptElement>("script[src]")) {
    const s = document.createElement("script");
    s.src = await blobUrl(tunnel, script.getAttribute("src")!, "text/javascript");
    document.head.append(s);
  }
}

// Only in the shell's sandboxed frame. This file is a public URL, and a meta
// CSP cannot say frame-ancestors: a page that framed it without the sandbox
// would be its parent, hand it a port of its own, and have the script it
// served run with the shell's origin, next to the browser's key. Sandboxed,
// the origin is opaque ("null"), whoever the parent is.
if (self.origin === "null") window.addEventListener("message", (e: MessageEvent) => {
  if (e.source !== window.parent || (e.data as { type?: unknown } | null)?.type !== "sculk-port" || !e.ports[0]) return;
  load(e.ports[0]).catch((err: unknown) => {
    document.body.textContent = `The game's UI did not load: ${err instanceof Error ? err.message : String(err)}`;
  });
});
