{
  description = "sculk-ui: the shell that reaches a sculk control server from any browser";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      # The site GitHub Pages serves: `nix build`, then .github/workflows/pages.yml uploads it.
      packages = forAllSystems (pkgs: {
        default = pkgs.callPackage ./site.nix { };
      });

      checks = forAllSystems (pkgs: {
        site = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
        # The tests under test/, type-checked and run under Node's WebCrypto.
        tests =
          pkgs.runCommand "sculk-ui-tests"
            {
              src = pkgs.lib.fileset.toSource {
                root = ./.;
                fileset = pkgs.lib.fileset.unions [
                  ./src
                  ./test
                  ./tsconfig.json
                  ./tsconfig.test.json
                ];
              };
              nativeBuildInputs = [
                pkgs.typescript
                pkgs.esbuild
                pkgs.nodejs
              ];
            }
            ''
              cd $src
              tsc -p tsconfig.test.json
              for t in test/*.test.ts; do
                esbuild "$t" --bundle --platform=node --format=esm --target=es2022 \
                  --loader:.csv=text --log-level=warning --outfile=$TMPDIR/test.mjs
                node $TMPDIR/test.mjs
              done
              touch $out
            '';
      });

      devShells = forAllSystems (pkgs: {
        # `tsc --watch` and `esbuild --watch` while working on it; `nix build` for the real thing.
        default = pkgs.mkShellNoCC {
          packages = [
            pkgs.typescript
            pkgs.esbuild
            pkgs.nodejs
          ];
        };
      });

      formatter = forAllSystems (pkgs: pkgs.nixfmt);
    };
}
