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
# Read with tree-sitter's TypeScript grammar: the list is whatever the exported
# `defaultRelayUrls` is declared as, and anything but a flat array of plain
# string literals is refused. Only that declaration has to parse cleanly; the
# grammar can lag new TypeScript syntax elsewhere in the file (it doesn't know
# `export type * from`, for one).
runCommand "sculk-relays"
  {
    nativeBuildInputs = [
      (python3.withPackages (p: [
        p.tree-sitter
        p.tree-sitter-grammars.tree-sitter-typescript
      ]))
    ];
    source = "${trystero}/packages/nostr/src/index.ts";
    # The source link names this commit, so the input must be a pinned one.
    rev = trystero.rev or (throw "relays: the trystero input has no rev; pin it to a commit");
  }
  ''
    mkdir -p $out
    python3 -I - <<'PY'
    import json, os, re, sys
    import tree_sitter, tree_sitter_typescript

    def fail(msg):
        sys.exit("relays: " + msg)

    parser = tree_sitter.Parser(tree_sitter.Language(tree_sitter_typescript.language()))
    root = parser.parse(open(os.environ["source"], "rb").read()).root_node

    decls = [
        d
        for s in root.named_children
        if s.type == "export_statement"
        and (lex := s.child_by_field_name("declaration")) is not None
        and lex.type == "lexical_declaration"
        for d in lex.named_children
        if d.type == "variable_declarator"
        and d.child_by_field_name("name").text == b"defaultRelayUrls"
    ]
    if len(decls) != 1:
        fail("exported defaultRelayUrls not found in Trystero's packages/nostr")
    decl = decls[0]
    if decl.has_error:
        fail("defaultRelayUrls doesn't parse: " + decl.text.decode())
    value = decl.child_by_field_name("value")
    if value is None or value.type != "array":
        fail("defaultRelayUrls isn't an array literal")

    urls = []
    for e in value.named_children:
        if e.type == "comment":
            continue
        parts = [c for c in e.named_children if c.type != "comment"] if e.type == "string" else None
        if parts is None or len(parts) != 1 or parts[0].type != "string_fragment":
            fail("defaultRelayUrls has an element that isn't a plain string: " + e.text.decode())
        urls.append(parts[0].text.decode())

    plain = r"wss://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:[0-9]+)?/?"
    bad = [u for u in urls if not re.fullmatch(plain, u)]
    if bad:
        fail(f"not plain wss:// URLs: {bad}")
    if len(set(urls)) != len(urls):
        fail("duplicates")
    if len(urls) < 20:
        fail(f"only {len(urls)}; expected at least 20")

    doc = {
        "source": "https://github.com/dmotz/trystero/tree/" + os.environ["rev"] + "/packages/nostr",
        "relays": urls,
    }
    with open(os.path.join(os.environ["out"], "relays.json"), "w") as f:
        json.dump(doc, f, indent=1)
        f.write("\n")
    print(f"{len(urls)} relays from Trystero {os.environ['rev']}")
    PY
  ''
