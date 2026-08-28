# Testing

Two layers: automated tests that need nothing, and a manual checklist against a
live account for the things that cannot be tested offline.

## Automated (offline)

```bash
npm run build
npm test
```

No API key, no network, no ReciPal account. The tests spawn the built server as a
real subprocess and talk MCP to it over stdio, so they exercise the actual
transport rather than importing internals. They cover:

- The MCP handshake, and that `serverInfo` reports a sane name and version.
- **22 tools with both gate flags set, 19 without** — the default surface never
  includes `delete_recipe`, `delete_recipe_ingredient`, or `recipal_request`.
- Every tool has a description and a valid `object` input schema, and every name
  listed in `required` is actually defined in `properties`.
- Calling a gated tool without its flag returns an error that **names the
  environment variable** to set.
- `recipal_request` with a mutating method still requires `confirm` even when the
  flag is on.
- Bulk tools default to a dry run that reports a plan and touches nothing.
- Unknown tool names are rejected.
- Startup refusals: missing `RECIPAL_API_KEY`, a non-`recipal.com` API base, and a
  non-https base each exit 1 with a specific message — and an explicitly allowed
  custom base starts fine.

The `test` script names test files explicitly rather than using a glob. Node's
`--test` flag only expands glob patterns on Node 21+, and npm scripts run through
`cmd.exe` on Windows, which does not expand globs at all — so a glob would silently
pass on Linux CI and fail for a Windows contributor. **If you add a test file, add it
to the `test` script in `package.json`.**

`npm run verify` runs typecheck, build, doc generation, and tests together. CI
does the same across Node 18, 20, and 22, and additionally fails if
`docs/TOOLS.md` is stale.

### What the offline tests deliberately do not cover

Anything requiring the real API: authentication, response envelope shapes, field
names, whether a write actually landed. Mocking ReciPal would only prove the mock
matches our assumptions — and our assumptions about this API have been wrong more
than once. That is what the live checklist is for.

## Manual (live account)

You need a paid ReciPal subscription and a working install
([SETUP.md](SETUP.md)).

> **Create a throwaway recipe first and use it as the target for every
> destructive step.** ReciPal has no undo. Do not run this checklist against a
> catalog you cannot reconstruct.

Substitute your own IDs for the placeholders. Each step is written as something to
ask the assistant.

### Reads

| # | Ask for | Expect |
|---|---|---|
| 1 | "List my recipes" | `id: name [tags]` lines with **real numeric IDs and names**. `undefined: undefined` or `?: Unnamed` means envelope parsing broke — see [DESIGN.md](DESIGN.md) |
| 2 | "List 100 recipes per page" | Up to 100 rows, not 20. Confirms `per_page` is honoured |
| 3 | "Get recipe `<ID>` in full" | Nutrition, serving size, package yield, tags, label settings. **Note the exact field names — you need them for writes** |
| 4 | "Show the nutrition for recipe `<ID>`" | Just the nutrition object, not the whole recipe |
| 5 | "List the ingredient lines on recipe `<ID>`" | One row per line, each with a `recipe_ingredient` id *and* an `ingredient_id`. A non-empty recipe returning `[]` is the envelope bug |
| 6 | "Get ingredient `<ID>`" | Per-100g nutrition and the list of available units |
| 7 | "List my ingredient library" | Includes any subrecipes you've created |

### Writes — on the throwaway

| # | Ask for | Expect |
|---|---|---|
| 8 | "Create a recipe called `zz-test`" | A new ID. Verify in the ReciPal web UI |
| 9 | "Rename recipe `<throwaway>` to `zz-test-renamed`" | 200, and the name changed in the UI |
| 10 | "Add ingredient `<ID>` to recipe `<throwaway>`, 50 grams" | A new `recipe_ingredient` id |
| 11 | "Change that line to 75 grams" | `total_grams` updated |
| 12 | "Copy recipe `<throwaway>` and call it `zz-test-copy`" | A new recipe with **label settings and tags carried over** — that's the point of `scale_recipe` |
| 13 | "Make recipe `<throwaway>` a subrecipe" | An **ingredient** record. Note its `ingredient_id`; that is what other recipes reference, and it is not the recipe id |

Step 13 is worth doing carefully — `create_subrecipe` returns an ingredient, and
confusing that ID with the recipe ID is the easiest mistake to make here.

### The dry-run contract

| # | Ask for | Expect |
|---|---|---|
| 14 | "Flag recipes `<A>` and `<B>` as subrecipes" | `dry_run: true` and a plan. **Nothing changed in the UI** |
| 15 | Same, "actually do it" | The assistant must pass `dry_run: false` **and** `confirm: true`. A per-recipe report with new `ingredient_id`s |
| 16 | "Clone `<template>` twice, swapping ingredient `<X>`" | Dry run prints the **template's ingredient lines with IDs**. Confirm the swap targets the line you expect *before* executing |
| 17 | Same, executed | Each clone's swapped line has the requested `ingredient_id`. If a swap silently kept the original ingredient, the delete-then-create path regressed |

Step 17 is the one that matters most. `PUT` on an ingredient line returns 200 and
silently ignores `ingredient_id`, so a broken swap looks like a success. The
server verifies the landed `ingredient_id` and fails the entry if it mismatches —
confirm that check still fires by reading the result report, not just the status.

### Gates

| # | Do | Expect |
|---|---|---|
| 18 | With no flags set, ask it to delete a recipe | The tool is **not in the tool list**. If forced, an error naming `RECIPAL_MCP_ALLOW_DELETE=1` |
| 19 | Set `RECIPAL_MCP_ALLOW_DELETE=1`, restart, delete the throwaway | Works. Gone from the UI |
| 20 | With `RECIPAL_MCP_ENABLE_RAW=1`, "GET /recipes/`<ID>`" via the raw tool | Raw JSON **including the outer envelope** — useful for discovering field names |

### Labels

| # | Ask for | Expect |
|---|---|---|
| 21 | "Request a PDF label render for recipe `<ID>`" | Accepted; renders take seconds |
| 22 | "Check the label status for recipe `<ID>`" | Status or label data. Never request more than 5 renders concurrently |

## Known failures — not regressions

Three things fail by design; don't spend time debugging them:

- **`create_recipe_shortcut` returns HTTP 422** for every ingredients-array format
  tried. ReciPal's docs truncate before the parameter list. If you work out the
  correct shape, that is a genuinely valuable PR.
- **`update_recipe_ingredient` ignores `ingredient_id`**, returning 200 with the
  original ingredient attached. Use delete-then-create.
- **Setting `tags` via `update_recipe` does not work** — silently dropped as a string,
  `500 ArgumentError` as an array or as `tag_list`. Clone a tagged template with
  `scale_recipe` instead.

## Reporting a bug

Include: what you asked for, the tool call and arguments, the full error, and the
stderr log with `RECIPAL_MCP_DEBUG=1` set. **Redact your API key and anything
about your recipes you'd rather not publish** — debug mode logs full request
bodies.
