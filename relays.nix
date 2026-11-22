# The Nostr relays remote access uses: Trystero's curated default list,
# taken from the pinned `trystero` flake input (its data only; none of its
# code is used). Published as /relays.json, which running games fetch, and
# compiled into the shell, so the two always agree. See schlarpc/sculk's
# docs/REMOTE.md.
#
# The weekly relays workflow bumps the input. A list that looks wrong fails
# here, and the site keeps its current one.
{
  runCommand,
  python3,
  trystero,
}:
runCommand "sculk-relays"
  {
    nativeBuildInputs = [ python3 ];
    source = "${trystero}/packages/nostr/src/index.ts";
    rev = trystero.rev or "unknown";
  }
  ''
    mkdir -p $out
    python3 -I - <<'PY'
    import json, os, re, sys
    text = open(os.environ["source"]).read()
    m = re.search(r"defaultRelayUrls\s*:\s*string\[\]\s*=\s*\[(.*?)\]", text, re.S)
    if not m:
        sys.exit("relays: defaultRelayUrls not found in Trystero's packages/nostr")
    urls = re.findall(r"'([^']*)'|\"([^\"]*)\"", m.group(1))
    urls = [a or b for a, b in urls]
    bad = [u for u in urls if not re.fullmatch(r"wss://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:[0-9]+)?/?", u)]
    if bad:
        sys.exit(f"relays: not plain wss:// URLs: {bad}")
    if len(set(urls)) != len(urls):
        sys.exit("relays: duplicates")
    if len(urls) < 20:
        sys.exit(f"relays: only {len(urls)}; expected at least 20")
    doc = {"source": "https://github.com/dmotz/trystero/tree/" + os.environ["rev"] + "/packages/nostr", "relays": urls}
    with open(os.path.join(os.environ["out"], "relays.json"), "w") as f:
        json.dump(doc, f, indent=1)
        f.write("\n")
    print(f"{len(urls)} relays from Trystero {os.environ['rev']}")
    PY
  ''
