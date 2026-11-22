// The shell (schlarpc/sculk's docs/REMOTE.md): reads the game's key from the
// link, meets the game on Nostr relays (signaling.ts), shows the approval
// code, and connects to it directly with WebRTC.
//
// This browser keeps its key (keystore.ts), so a game that remembers it lets
// it back in without asking, and keeps the servers it has reached, which the
// page lists when opened without a link. Once connected, the game's own UI
// runs in a sandboxed frame (frame.ts), its requests tunneled to the game
// (tunnel.ts).

import { type SavedServer, browserKey, forgetServer, keepServer, renameServer, savedServer, savedServers } from "./keystore";
import type { Bytes } from "./noise";
import { RELAYS } from "./relays";
import { BrowserSignaling, type Status } from "./signaling";
import { TunnelClient } from "./tunnel";

const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun.cloudflare.com:3478" }];
/** Gathering candidates normally ends in well under this; past it, offer what there is. */
const GATHER_MS = 5000;
/**
 * A game answers the first message within seconds when it is running. Past
 * this, say so (it keeps trying): it may be stopped, or its key changed
 * (a deleted server.key), and then it never will.
 */
const SILENT_MS = 30_000;
/** The shell's own tunnel streams, apart from the game's UI's (which count from 1). */
const SHELL_STREAMS = 0x80000000;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls !== undefined) e.className = cls;
  return e;
}

/** A game's key (base64url, 43 characters, as in its link), or null. */
function decodeKey(text: string): Bytes | null {
  const s = text.trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(s)) return null;
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=");
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.length === 32 ? out : null;
}

/** The game's key from the link's fragment, or null. */
function serverKey(): Bytes | null {
  return decodeKey(decodeURIComponent(location.hash.slice(1)));
}

function encodeKey(key: Bytes): string {
  let s = "";
  for (const x of key) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function button(text: string, onClick: () => void, cls?: string): HTMLButtonElement {
  const b = el("button", text, cls);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

/** A kept server's label: its name, or the start of its key. */
function label(s: SavedServer): string {
  return s.name || `server ${s.key.slice(0, 8)}…`;
}

function when(t: number): string {
  return new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** The page without a link: the servers this browser has reached. */
async function showServers(app: HTMLElement): Promise<void> {
  const list = await savedServers();
  if (list.length === 0) {
    app.append(el("p", "This page connects to a running game through the link that sculk prints."));
    app.append(el("p", "Games you connect to are kept here, so you can come back without the link.", "dim"));
    return;
  }
  app.append(el("p", "Games this browser has connected to:"));
  const ul = el("ul", undefined, "servers");
  for (const s of list) {
    const li = el("li");
    const open = button(label(s), () => {
      const key = decodeKey(s.key);
      if (key === null) return;
      for (const child of [...app.children]) if (child.tagName !== "H1") child.remove();
      connect(app, key, s).catch((e: unknown) => failed(app, e));
    }, "server");
    const rename = button("rename", () => {
      const name = prompt("A name for this game:", s.name)?.trim();
      if (name === undefined) return;
      void renameServer(s.key, name.slice(0, 80)).then(() => {
        s.name = name.slice(0, 80);
        open.textContent = label(s);
      });
    }, "small");
    const forget = button("forget", () => {
      if (!confirm(`Forget ${label(s)}? You will need its link to connect again.`)) return;
      void forgetServer(s.key).then(() => li.remove());
    }, "small");
    li.append(open, el("span", `last connected ${when(s.lastConnected)}`, "dim"), rename, forget);
    ul.append(li);
  }
  app.append(ul);
  app.append(el("p", "A game that is running but does not answer may have a new key: open the link it prints now.", "dim"));
}

function failed(app: HTMLElement, e: unknown): void {
  app.append(el("p", `Something went wrong: ${e instanceof Error ? e.message : String(e)}`));
}

/**
 * Keeps the server just connected to, named after its platform unless it
 * has a name: asked through the shell's own tunnel streams, beside the
 * game's UI's. Registered before the frame's listener, which transfers the
 * message buffers it forwards.
 */
function keepConnected(channel: RTCDataChannel, keyText: string): void {
  const tunnel = new TunnelClient(
    {
      send: (m) => {
        if (channel.readyState === "open") channel.send(m as Uint8Array<ArrayBuffer>);
      },
      onMessage: (h) => channel.addEventListener("message", (e: MessageEvent) => h(new Uint8Array(e.data as ArrayBuffer))),
    },
    SHELL_STREAMS,
  );
  void (async () => {
    const kept = await keepServer(keyText);
    if (!kept || kept.name) return;
    try {
      const status = (await (await tunnel.fetch("/api/status", { headers: { Accept: "application/json" } })).json()) as { platform?: unknown };
      if (typeof status.platform === "string" && status.platform) await keepServer(keyText, status.platform.slice(0, 80));
    } catch {
      // Unnamed, then: the list shows the start of its key.
    }
  })();
}

/** A complete offer: every candidate gathered, so there is nothing to trickle. */
async function completeOffer(pc: RTCPeerConnection): Promise<string> {
  await pc.setLocalDescription(await pc.createOffer());
  if (pc.iceGatheringState !== "complete") {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, GATHER_MS);
      pc.addEventListener("icegatheringstatechange", () => {
        if (pc.iceGatheringState === "complete") {
          clearTimeout(timer);
          resolve();
        }
      });
    });
  }
  return pc.localDescription!.sdp;
}

/**
 * The game's own UI, in a sandboxed frame (frame.html): this page hands it a
 * MessagePort, and carries what it sends to the data channel and back, so
 * the UI reaches its game and nothing else.
 */
function showGame(channel: RTCDataChannel, status: HTMLElement): void {
  status.textContent = "Connected. Loading the game's UI…";
  const frame = el("iframe");
  frame.title = "sculk";
  // No allow-same-origin: an opaque origin, away from this page's keys and storage.
  frame.setAttribute("sandbox", "allow-scripts allow-modals allow-downloads");
  frame.setAttribute("allow", "clipboard-write");
  frame.src = "/frame.html";
  frame.addEventListener("load", () => {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = (e: MessageEvent) => {
      if (channel.readyState === "open") channel.send(e.data as ArrayBuffer);
    };
    channel.addEventListener("message", (e: MessageEvent) => {
      const data = e.data as ArrayBuffer;
      port1.postMessage(data, [data]);
    });
    // The frame's origin is opaque, so "*" is the only target that reaches it.
    frame.contentWindow?.postMessage({ type: "sculk-port" }, "*", [port2]);
    document.body.classList.add("game");
  }, { once: true });
  document.body.append(frame);
}

async function connect(app: HTMLElement, key: Bytes, saved?: SavedServer): Promise<void> {
  const keyText = encodeKey(key);
  saved ??= await savedServer(keyText);
  const status = el("p", saved ? `Finding ${label(saved)}…` : "Finding the game…", "dim");
  app.append(status);

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const channel = pc.createDataChannel("sculk");
  const offer = await completeOffer(pc);
  const { key: staticKey, kept } = await browserKey();

  let signaling: BrowserSignaling | null = null;
  let silent: HTMLElement | null = null;
  const silence = setTimeout(() => {
    silent = el("p", "The game is not answering. It may not be running, or its key changed, and then it never will: "
      + "open the link it prints now. Still trying…", "dim");
    if (saved) {
      const s = saved;
      silent.append(" ", button("forget this game", () => {
        void forgetServer(s.key).then(() => {
          signaling?.close();
          silent?.replaceChildren("Forgotten. ");
          const back = el("a", "Back to your games");
          back.href = "/";
          silent?.append(back);
        });
      }, "small"));
    }
    app.append(silent);
  }, SILENT_MS);
  const onStatus = async (s: Status) => {
    clearTimeout(silence);
    silent?.remove();
    switch (s.status) {
      case "pending":
        status.textContent = "";
        status.className = "";
        status.append("Waiting for approval in game. Check that it shows ");
        status.append(el("code", s.code));
        status.append(".");
        if (!kept) app.append(el("p", "This browser cannot keep its key here (a private window?), so the game cannot remember it.", "dim"));
        break;
      case "approved":
        status.textContent = "Approved. Connecting…";
        status.className = "dim";
        await pc.setRemoteDescription({ type: "answer", sdp: s.sdp });
        break;
      case "denied":
        status.textContent = "The game refused this browser.";
        signaling?.close();
        break;
      case "expired":
        status.textContent = "Nobody approved this browser in time. Reload to try again.";
        signaling?.close();
        break;
    }
  };
  signaling = await BrowserSignaling.start({ serverKey: key, staticKey, offer, relays: RELAYS, onStatus: (s) => void onStatus(s) });

  pc.addEventListener("connectionstatechange", () => {
    if (pc.connectionState === "failed") {
      status.textContent = "Could not connect directly to the game (both sides may be behind strict NAT).";
      status.className = "";
    }
  });
  channel.binaryType = "arraybuffer";
  channel.addEventListener("open", () => {
    signaling?.close();
    keepConnected(channel, keyText);
    showGame(channel, status);
  });
  channel.addEventListener("close", () => {
    status.textContent = "Disconnected.";
    status.className = "dim";
  });
}

function main(): void {
  const app = document.getElementById("app");
  if (app === null) return;

  // A meta CSP cannot say frame-ancestors, so a page that frames this one
  // (to trick someone into approving something) gets nothing.
  if (window.top !== window.self) {
    app.append(el("p", "sculk does not run in a frame. Open it in its own tab."));
    return;
  }

  app.append(el("h1", "sculk"));
  const key = serverKey();
  if (key === null) {
    showServers(app).catch((e: unknown) => failed(app, e));
    return;
  }
  // Keep the key out of the address bar, history and screenshots.
  history.replaceState(null, "", location.pathname);
  connect(app, key).catch((e: unknown) => failed(app, e));
}

main();
