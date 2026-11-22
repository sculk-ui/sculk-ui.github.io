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
  ];

  buildPhase = ''
    runHook preBuild
    tsc -p tsconfig.json
    esbuild src/main.ts --bundle --minify --sourcemap --target=es2022 \
      --legal-comments=none --outfile=dist/shell.js
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out
    cp -r static/. dist/. $out/
    runHook postInstall
  '';

  meta.description = "Shell for reaching a sculk control server from a browser";
}
