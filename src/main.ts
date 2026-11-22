// The shell (schlarpc/sculk's docs/REMOTE.md): reads the game's key from the
// link, meets the game on Nostr relays (signaling.ts), shows the approval
// code, and connects to it directly with WebRTC.
//
// This browser keeps its key (keystore.ts), so a game that remembers it lets
// it back in without asking. Once connected, the game's own UI runs in a
// sandboxed frame (frame.ts), its requests tunneled to the game (tunnel.ts).
// Still to come: remembered servers.

import { browserKey } from "./keystore";
import type { Bytes } from "./noise";
import { RELAYS } from "./relays";
import { BrowserSignaling, type Status } from "./signaling";

const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun.cloudflare.com:3478" }];
/** Gathering candidates normally ends in well under this; past it, offer what there is. */
const GATHER_MS = 5000;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls !== undefined) e.className = cls;
  return e;
}

/** The game's key from the link's fragment (base64url, 43 characters), or null. */
function serverKey(): Bytes | null {
  const s = decodeURIComponent(location.hash.slice(1)).trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(s)) return null;
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=");
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.length === 32 ? out : null;
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

async function connect(app: HTMLElement, key: Bytes): Promise<void> {
  const status = el("p", "Finding the game…", "dim");
  app.append(status);

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const channel = pc.createDataChannel("sculk");
  const offer = await completeOffer(pc);
  const { key: staticKey, kept } = await browserKey();

  let signaling: BrowserSignaling | null = null;
  const onStatus = async (s: Status) => {
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
    app.append(el("p", "This page connects to a running game through the link that sculk prints."));
    return;
  }
  // Keep the key out of the address bar, history and screenshots.
  history.replaceState(null, "", location.pathname);
  connect(app, key).catch((e: unknown) => {
    app.append(el("p", `Something went wrong: ${e instanceof Error ? e.message : String(e)}`));
  });
}

main();
