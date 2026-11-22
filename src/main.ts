// The shell: for now it only refuses to run in a frame and reads the link.
// The plan (schlarpc/sculk#3): Noise XK to the game over a relay or WebRTC,
// approval, remembered browsers, and the game's own UI in a sandboxed frame.

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls !== undefined) e.className = cls;
  return e;
}

/** The server's key from the link's fragment, which browsers never send anywhere. */
function serverKey(): string | null {
  const key = decodeURIComponent(location.hash.slice(1)).trim();
  return key === "" ? null : key;
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
    app.append(
      el("p", "This page connects to a running game through the link that sculk prints."),
      el("p", "Remote access is not built yet.", "dim"),
    );
  } else {
    const p = el("p", "Server key: ");
    p.append(el("code", key));
    app.append(p, el("p", "Remote access is not built yet, so there is nothing to connect to.", "dim"));
    // Keep the key out of the address bar, history and screenshots.
    history.replaceState(null, "", location.pathname);
  }
}

main();
