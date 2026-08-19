# Security

## Reporting a vulnerability

Open a GitHub issue for anything non-sensitive. For something you'd rather not
disclose publicly, use GitHub's private vulnerability reporting on this
repository ("Security" → "Report a vulnerability") rather than a public issue.

Please don't report ReciPal's own vulnerabilities here — this project is
unaffiliated with them. Contact ReciPal directly.

## Threat model, stated plainly

This server hands an AI assistant write access to your recipe catalog. That is
the point of it, and it is also the risk.

**Your ReciPal API key carries full read, write, and delete access to every
recipe and ingredient in your account.** There is no read-only key and no
scoping. This server never logs the key, sends it only as an `Authorization`
header, and refuses to send it to a non-`recipal.com` host unless you explicitly
set `RECIPAL_MCP_ALLOW_CUSTOM_BASE=1`.

**The `confirm: true` and `dry_run` parameters are not a human-in-the-loop
control.** They are supplied by the model. They defend against a vague prompt
being interpreted destructively; they do not defend against a model that has
decided to delete something, or against prompt injection reaching the model
through recipe data or any other tool in the same session. Treat them as a speed
bump, not a gate.

The actual gates are environment variables, which only the person running the
server can set:

- `RECIPAL_MCP_ALLOW_DELETE=1` — required for `delete_recipe` and
  `delete_recipe_ingredient`. Without it they are not advertised and calls are
  refused.
- `RECIPAL_MCP_ENABLE_RAW=1` — required for `recipal_request`, which can issue
  any method against any endpoint.

Leave both unset unless you have a specific need.

## Recommendations

- **ReciPal has no undo.** Export or otherwise record anything you can't
  reconstruct before running a bulk operation.
- Run bulk tools in `dry_run` first and read the plan. `bulk_clone_and_swap`
  prints the template's ingredient lines in dry-run mode specifically so you can
  confirm which line the swap targets.
- Test against a throwaway recipe before touching a production catalog.
- Keep `RECIPAL_MCP_DEBUG` off in normal use. It logs full request bodies —
  your recipe data — to stderr, which most MCP clients write to a log file.
- Keep your key out of the repository. `.env` and `.env.*` are gitignored;
  `.env.example` is the only committed variant. If you paste a key into a client
  config file, remember that file is not covered by this repo's `.gitignore`.
- Rotate the key in ReciPal's account settings if you suspect exposure.

## Supported versions

This is a small project. Fixes land on `main`; there are no backported release
branches.
