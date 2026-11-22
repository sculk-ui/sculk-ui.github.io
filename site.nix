# The shell: TypeScript type-checked by tsc and bundled by esbuild, both from
# nixpkgs. No npm dependencies, so no lock file. Everything this page runs is
# in this repo; keep it that way, since the shell is the part users must trust.
#
#   nix build
{
  lib,
  stdenvNoCC,
  esbuild,
  typescript,
  jq,
  python3,
  relays,
}:
stdenvNoCC.mkDerivation {
  pname = "sculk-ui";
  version = "0.1.0";

  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      ./src
      ./static
      ./tsconfig.json
    ];
  };

  nativeBuildInputs = [
    esbuild
    typescript
    jq
    python3
  ];

  buildPhase = ''
    runHook preBuild
    # The relays (relays.nix): compiled in, and the only places the page may connect to.
    cp ${relays}/relays.json src/relays.json
    substituteInPlace static/index.html \
      --replace-fail @connectSrc@ "$(jq -r '.relays | join(" ")' src/relays.json)"
    tsc -p tsconfig.json
    esbuild src/main.ts --bundle --minify --sourcemap --target=es2022 \
      --legal-comments=none --outfile=dist/shell.js
    # The sandboxed frame: its loader inline, allowed by hash in its own CSP.
    esbuild src/frame.ts --bundle --minify --target=es2022 \
      --legal-comments=none --outfile=frame.js
    python3 - <<'PY'
    import base64, hashlib
    script = open("frame.js").read().rstrip("\n")
    if "</script" in script.lower():
        raise SystemExit("frame.js holds </script, which would end the inline script")
    digest = base64.b64encode(hashlib.sha256(script.encode()).digest()).decode()
    page = open("static/frame.html").read()
    page = page.replace("@frameHash@", "sha256-" + digest).replace("@frameScript@", script)
    open("dist/frame.html", "w").write(page)
    PY
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out
    cp -r static/. dist/. $out/  # dist/frame.html replaces the template
    # For running games, which fetch it (schlarpc/sculk's docs/REMOTE.md).
    cp src/relays.json $out/relays.json
    runHook postInstall
  '';

  meta.description = "Shell for reaching a sculk control server from a browser";
}
