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
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out
    cp -r static/. dist/. $out/
    # For running games, which fetch it (schlarpc/sculk's docs/REMOTE.md).
    cp src/relays.json $out/relays.json
    runHook postInstall
  '';

  meta.description = "Shell for reaching a sculk control server from a browser";
}
