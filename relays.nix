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
  nodejs,
  typescript_5,
  trystero,
}:
# Read with TypeScript's own parser: the list is whatever `defaultRelayUrls`
# is declared as, and anything but a flat array of string literals is refused.
# typescript_5, since nixpkgs' `typescript` (7.x, the Go port) has no JS API.
runCommand "sculk-relays"
  {
    nativeBuildInputs = [ nodejs ];
    NODE_PATH = "${typescript_5}/lib/node_modules";
    source = "${trystero}/packages/nostr/src/index.ts";
    # The source link names this commit, so the input must be a pinned one.
    rev = trystero.rev or (throw "relays: the trystero input has no rev; pin it to a commit");
  }
  ''
    mkdir -p $out
    node --input-type=commonjs - <<'JS'
    const fs = require("fs");
    const path = require("path");
    const ts = require("typescript");
    const fail = (msg) => {
      console.error("relays: " + msg);
      process.exit(1);
    };

    const file = process.env.source;
    const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
    if (sf.parseDiagnostics.length) fail("Trystero's packages/nostr doesn't parse");

    const decls = sf.statements
      .filter(ts.isVariableStatement)
      .filter((s) => s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
      .flatMap((s) => s.declarationList.declarations)
      .filter((d) => ts.isIdentifier(d.name) && d.name.text === "defaultRelayUrls");
    if (decls.length !== 1) fail("exported defaultRelayUrls not found in Trystero's packages/nostr");
    const init = decls[0].initializer;
    if (!init || !ts.isArrayLiteralExpression(init)) fail("defaultRelayUrls isn't an array literal");
    const urls = init.elements.map((e) => {
      if (!ts.isStringLiteral(e) && !ts.isNoSubstitutionTemplateLiteral(e))
        fail("defaultRelayUrls has a non-literal element: " + e.getText(sf));
      return e.text;
    });

    const plain = /^wss:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:[0-9]+)?\/?$/;
    const bad = urls.filter((u) => !plain.test(u));
    if (bad.length) fail("not plain wss:// URLs: " + JSON.stringify(bad));
    if (new Set(urls).size !== urls.length) fail("duplicates");
    if (urls.length < 20) fail("only " + urls.length + "; expected at least 20");

    const doc = {
      source: "https://github.com/dmotz/trystero/tree/" + process.env.rev + "/packages/nostr",
      relays: urls,
    };
    fs.writeFileSync(path.join(process.env.out, "relays.json"), JSON.stringify(doc, null, 1) + "\n");
    console.log(urls.length + " relays from Trystero " + process.env.rev);
    JS
  ''
