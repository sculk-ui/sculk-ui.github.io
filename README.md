# sculk-ui

The page at <https://sculk-ui.github.io/>, which will reach a running
[sculk](https://github.com/schlarpc/sculk) control server from any browser,
with no port forwarding and a relay that sees only ciphertext. The design is in
[schlarpc/sculk#3](https://github.com/schlarpc/sculk/issues/3).

Today it is a stub: it reads the server key from a link's fragment and says
remote access is not built yet.

## Why a whole org for one page

Every Pages site under one account or org shares an origin, and with it
storage. This page will hold browser keys and remembered servers, so it lives
alone in its own org. **Do not turn on Pages for any other repo in
`sculk-ui`.**

The page is also the one piece of hosted code users must trust, so:

- everything it runs is in this repo, with no npm dependencies;
- the CSP is a `<meta>` tag (Pages cannot set headers), and the page refuses to
  run in a frame, since a meta CSP cannot say `frame-ancestors`;
- each deploy's build log lists the SHA-256 of every file served; `nix build`
  here should give the same files.

## Building

```sh
nix build          # the site, in result/
nix flake check
nix develop        # tsc and esbuild, to work on it with --watch
```

Pushes to `main` deploy through `.github/workflows/pages.yml`.
