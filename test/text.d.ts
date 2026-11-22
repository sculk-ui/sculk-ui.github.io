// esbuild loads these as text (see the tests check in flake.nix).
declare module "*.csv" {
  const text: string;
  export default text;
}
