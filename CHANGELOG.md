# Changelog

All notable changes to this project. Versions before 0.4.0 were internal and are
summarised here for context rather than documented in full.

## 0.6.0

- Fixed every `BlackBlack` GitHub URL in `package.json`, `README.md`, and `docs/SETUP.md`. The README clone command was pointing at a non-existent account.
- `create_recipe_shortcut` now works. The correct shape is `ingredient_ids` and `ingredient_weights` as parallel comma-separated strings, weights in grams. Either may be an array or a comma-separated string. ReciPal improved the 422 error message, which is what made the shape discoverable.
- npm publishing is now permitted: removed `"private": true`, added `files: ["build"]` and a `prepare` script, so `npx -y recipal-mcp-unofficial` and `npm install github:RBV801/recipal-mcp-unofficial` work. `README.md` and `docs/SETUP.md` now lead with npx.
- The `per_page` ceiling is 20, not 100; the API silently reduces larger values to 20.
- Documented that a wrong or unowned ID returns `401 Unauthorized`, not `404` (in `README.md` and `docs/SETUP.md`), and that unrecognised recipe attributes are silently dropped on `PUT` (in `README.md`).
- Documented that `tags` cannot be set through `update_recipe` — a string returns 200 and is silently dropped, while an array or `tag_list` returns `500 ArgumentError`. Tags still carry forward through `scale_recipe` cloning a tagged template.
- `FIELDS_DESC` now lists the attribute names that actually appear in `get_recipe` responses.
- Narrowed the distribution restriction to the one thing ReciPal asked for: no assistant plugin packages. npm, registry listings, and npx are no longer excluded.
- `SUNSET.md` softened to match ReciPal's actual wording, added an upstream-fork invitation, and added an `npm deprecate` step to the archive checklist.

## 0.5.0 — renamed, per agreement with ReciPal

ReciPal reviewed this project and agreed to it being published, subject to three things. No
functional change to any endpoint call; this release is entirely about identity and scope.

### Changed

- **Renamed `recipal-mcp` → `recipal-mcp-unofficial`** everywhere it is user-visible: the
  repository, the npm package name, the `bin` entry, the **name advertised in the MCP handshake**
  (what your client displays), and the stderr log prefix. Requested by ReciPal so this cannot be
  confused with the official server they are building.
- If you installed an earlier version, the server will now appear under the new name in your MCP
  client. The registration key in your own client config is yours to choose and does not have to
  change.

### Added

- `SUNSET.md` — the archive plan. When ReciPal's official server ships, this repository points at
  it and is archived read-only.
- `CONTRIBUTING.md` — what is in scope, and why packaged/consumer distribution is not.
- A **Scope and distribution** section in the README recording the no-plugin, no-marketplace,
  no-npm commitment, so it survives contact with well-meaning pull requests.
- An interim-project notice at the top of the README.

## 0.4.0 — first public release

Preparation for open-sourcing. No changes to how any ReciPal endpoint is called;
the changes are to safety defaults, resilience, and documentation.

### Changed — potentially breaking for existing installs

- **`delete_recipe`, `delete_recipe_ingredient`, and `recipal_request` are no
  longer exposed by default.** They now require `RECIPAL_MCP_ALLOW_DELETE=1` or
  `RECIPAL_MCP_ENABLE_RAW=1` in the server environment. The default surface is 19
  tools; all 22 with both flags set. Rationale: the `confirm: true` guards are
  supplied by the model, not by a human, so they are not a real gate on
  irreversible operations.
- **Request bodies are no longer logged unless `RECIPAL_MCP_DEBUG=1`.** Bodies
  contain recipe data and most MCP clients persist stderr to a log file. Method
  and path are still logged.

### Added

- **HTTP 429 handling.** Honours `Retry-After`, falls back to exponential
  backoff (capped at 30s), retries up to `RECIPAL_MCP_MAX_RETRIES` (default 3).
  Reads `X-RateLimit-*` headers, warns on stderr when fewer than 100 requests
  remain, and includes remaining quota in the error when it gives up.
- **API base URL validation.** `RECIPAL_API_BASE` must be https and a
  `recipal.com` host, since the API key is sent to whatever it points at.
  `RECIPAL_MCP_ALLOW_CUSTOM_BASE=1` overrides this for testing.
- `User-Agent: recipal-mcp-unofficial/<version>` on all requests.
- Offline smoke tests (`npm test`) covering the handshake, both gate states,
  schema validity, and each startup-refusal path. No API key or network needed.
- `docs/TOOLS.md`, generated from the running server (`npm run gen:docs`). CI
  fails if it is stale.
- CI across Node 18, 20, and 22.
- Apache-2.0 license, `SECURITY.md`, `.env.example`.

### Fixed

- Renamed `findIngredientLines` to `extractRecords` — it parses recipe lists as
  well as ingredient lines, and the old name misled.
- Removed an `as never` cast on the tool list by typing it as `Tool[]`.
- `create_recipe_shortcut` and `update_recipe_ingredient` tool descriptions now
  state their known defects (see below) instead of advertising behaviour that
  does not work.

### Known defects carried forward

- `create_recipe_shortcut` returns HTTP 422 for every ingredients-array format
  tried. ReciPal's docs truncate before the parameter list.
- `PUT /recipe_ingredients/{id}` silently ignores `ingredient_id`, returning 200
  with the original ingredient attached. Swaps must be delete-then-create.

## 0.3.1 — internal

Fixed response-envelope parsing. ReciPal returns collections double-wrapped, e.g.
`{recipe: {recipe_ingredients: [{recipe_ingredient: {…}}]}}`, and the parser was
reading fields off the outer envelope — which fails silently, returning empty
arrays and `undefined` IDs rather than an error.

The fix walks both envelope layers (`extractRecords`) and unwraps single-key
objects (`unwrap`). Every site that reads an ID out of a response was audited:
the clone ID in `bulk_clone_and_swap`, the new ingredient ID in
`bulk_create_subrecipes`, and `get_recipe_nutrition`.

Also established that swapping an ingredient requires delete-then-create, because
`PUT` on an ingredient line discards `ingredient_id` without erroring.

## 0.3.0 — internal

First fix for the envelope problem; superseded by 0.3.1 after the audit found
more affected call sites.

## 0.2.0 — internal

Expanded from one tool to 22: full read coverage, recipe and ingredient-line
writes, subrecipes, copy/scale, label render requests, two sequential bulk loops,
and the `recipal_request` escape hatch. Established the open `fields` pass-through
design and the `dry_run`/`confirm` convention.

## 0.1.0 — internal

Scaffold: stdio transport, token auth, and `list_recipes`.
