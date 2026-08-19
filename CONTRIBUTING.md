# Contributing

Thanks for looking. Two things to know before you invest time, because they will
determine whether a pull request can be merged.

## This project is intentionally short-lived

ReciPal is building an official MCP server. When it ships, this repository will be
updated to point at theirs and then archived read-only — see [SUNSET.md](SUNSET.md).

That is not a reason to avoid contributing. It *is* a reason to prefer small,
high-value changes over large ones. A fix that helps people during the interim is
worth making. A refactor that pays off over two years is not.

## Scope is fixed by an agreement, not by preference

ReciPal reviewed this project and agreed to its publication on three conditions:
the `-unofficial` name, no consumer-facing plugin distribution, and archival once
their official server is live. Those are commitments, so the following will be
declined no matter how well implemented:

- A packaged plugin bundle of any kind (`.mcpb`, `.dxt`, a Claude Desktop
  extension, an installer).
- Submission to or metadata for any MCP directory, registry, or marketplace.
- Publishing to npm, or removing `"private": true` from `package.json`.
- Renaming away from `recipal-mcp-unofficial`, or any wording that implies ReciPal
  endorses, supports, or is affiliated with this project.

Not a judgement on the idea — several of those would genuinely be nicer for users.
They are simply not ours to do.

## What is genuinely welcome

Ranked by how much it would help:

1. **The `create_recipe_shortcut` request shape.** It returns HTTP 422 for every
   ingredients-array format tried, and ReciPal's published docs truncate before the
   parameter list. If you work it out, that is the single most useful contribution
   available here.
2. **Parameter names for `scale_recipe` and `create_subrecipe`**, which are also
   unpublished. Currently handled by passing `fields` through untouched.
3. **Corrections to documented API behaviour.** Several claims in the README and
   [docs/DESIGN.md](docs/DESIGN.md) were established by probing the live API — that
   `PUT` on an ingredient line silently discards `ingredient_id`, that `scale` needs
   `POST` despite the docs saying `PUT`, the double-nested response envelopes. If
   any of that is wrong or has changed, say so.
4. **Bug fixes**, especially anything where a call appears to succeed but doesn't.
   That failure mode has bitten this project twice.
5. **Better error messages**, particularly ones that tell a user what to do next.

## Practical notes

```bash
npm install
npm run verify   # typecheck, build, regenerate docs/TOOLS.md, run tests
```

- **`docs/TOOLS.md` is generated. Never edit it by hand.** Tool descriptions live in
  the `TOOLS` array in `src/index.ts`. Run `npm run build && npm run gen:docs` and
  commit the result — CI fails if it is stale. Hand-maintained tool docs in this
  project once drifted into describing three tools that never existed, which is why
  it works this way.
- **Tool descriptions are read by a model, not just by people.** Say when to use a
  tool and what to call first. That is more valuable than terse accuracy.
- **Route every response read through `unwrap()` or `extractRecords()`.** Reading a
  field off a raw ReciPal response returns `undefined` without erroring.
- **Never write to stdout.** It carries the JSON-RPC stream; one `console.log`
  corrupts the protocol and the client's error will not tell you why. Use `log()`,
  which writes to stderr.
- **Anything destructive or unbounded gets an environment-variable gate** in the
  `GATED` map. `confirm: true` is supplied by the model, so it is not a real gate.
- **Tests are offline** and need no API key. If you change behaviour, cover it.
- Adding a test file? Add it to the `test` script in `package.json` — it lists files
  explicitly because Node only expands `--test` globs on 21+, and npm scripts run
  through `cmd.exe` on Windows, which never expands them.

## Reporting bugs and vulnerabilities

Bugs: open an issue with what you asked for, the tool call and arguments, and the
stderr output with `RECIPAL_MCP_DEBUG=1`. **Redact your API key and any recipe data
you would rather not publish** — debug mode logs full request bodies.

Security: use GitHub's private vulnerability reporting on this repository, not a
public issue. See [SECURITY.md](SECURITY.md). ReciPal's own vulnerabilities go to
ReciPal, not here.
