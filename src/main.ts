// The shell (schlarpc/sculk's docs/REMOTE.md): reads the game's key from the
// link, meets the game on Nostr relays (signaling.ts), shows the approval
// code, and connects to it directly with WebRTC.
//
// Still to come: remembered browsers and servers, and the game's own UI in a
// sandboxed frame over the data channel. Until then, a connected page offers
// a message box, which the game echoes.

import { type Bytes, generateKeyPair } from "./noise";
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

async function connect(app: HTMLElement, key: Bytes): Promise<void> {
  const status = el("p", "Finding the game…", "dim");
  app.append(status);

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const channel = pc.createDataChannel("sculk");
  const offer = await completeOffer(pc);
  // A fresh key per visit for now; remembering this browser comes later.
  const staticKey = await generateKeyPair(false);

  let signaling: BrowserSignaling | null = null;
  const onStatus = async (s: Status) => {
    switch (s.status) {
      case "pending":
        status.textContent = "";
        status.className = "";
        status.append("Waiting for approval in game. Check that it shows ");
        status.append(el("code", s.code));
        status.append(".");
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
  channel.addEventListener("open", () => {
    signaling?.close();
    status.textContent = "Connected.";
    status.className = "";
    const log = el("pre");
    const input = el("input");
    input.placeholder = "message";
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && input.value !== "") {
        channel.send(input.value);
        log.append(`> ${input.value}\n`);
        input.value = "";
      }
    });
    channel.addEventListener("message", (e) => log.append(`< ${String(e.data)}\n`));
    app.append(input, log);
    input.focus();
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
