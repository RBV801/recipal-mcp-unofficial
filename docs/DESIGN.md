# Design

Why this server is built the way it is, and what you need to know before
extending it. Most of what follows exists because the ReciPal API behaves
differently from what its documentation implies.

## Shape

One process, one file, no state.

```
MCP client (Claude Code / Desktop)
      │  JSON-RPC 2.0 over stdio
      ▼
build/index.js            ← this server, launched as a subprocess
      │  HTTPS, Authorization: Token token=KEY
      ▼
https://www.recipal.com/api/v1
```

No server to deploy, no database, no cache, no OAuth. The client owns the
lifecycle: it spawns the process, speaks JSON-RPC on stdin/stdout, and kills it
on exit.

```
src/index.ts              everything: config, HTTP layer, tool defs, handlers
scripts/mcp-harness.mjs   minimal stdio JSON-RPC client
scripts/gen-tools-doc.mjs generates docs/TOOLS.md from the running server
test/smoke.test.mjs       offline protocol and safety-gate tests
```

`index.ts` is one file on purpose — it is under a thousand lines, and the whole
thing fits in a single reading. Split it when that stops being true.

## stdout is sacred

stdout carries the JSON-RPC stream. **A single `console.log` anywhere in this
server corrupts the protocol** and the client's failure mode is an opaque parse
error, not a useful message. All logging goes through `log()`, which writes to
stderr. The smoke-test harness treats non-JSON on stdout as a hard failure
specifically to catch a regression here.

## ReciPal double-wraps its responses

This is the single most important thing to know. Responses arrive wrapped in an
envelope keyed by resource name, and collections are wrapped at two levels:

```json
{ "recipe": { "recipe_ingredients": [ { "recipe_ingredient": { "id": 1 } } ] } }
```

```json
[ { "recipe": { "id": 1 } }, { "recipe": { "id": 2 } } ]
```

Reading `.id` off the outer object yields `undefined`. **It does not throw.** The
observable symptom is a recipe that appears to have no ingredients, or a list of
`"undefined: undefined"` rows — which reads like an API problem or a data problem
and is neither. This cost real debugging time twice.

Two helpers handle it:

- `unwrap(o)` — strips a single-key object envelope. Use on any single-resource
  response before reading fields.
- `extractRecords(payload)` — descends up to three envelope layers looking for an
  array under `recipe_ingredients`, `ingredients`, `recipes`, `data`, or
  `results`, then unwraps each element. Use on any collection response.

**If you add a tool that reads anything out of a response, route it through one of
these.** `pickId(obj, ...keys)` is the companion for pulling an ID that might be
called `id` or `ingredient_id` depending on endpoint.

## Write tools take an open `fields` object

Every write tool has the same shape:

```ts
update_recipe({ recipe_id, fields: { …anything… }, as_json? })
```

rather than a fixed parameter list. This is deliberate. ReciPal's published API
docs truncate before the complete recipe attribute list, so a fixed parameter
list would have been guesswork, and would silently drop any attribute we guessed
wrong or that ReciPal added later. Pass-through means undocumented attributes
work without a code change.

The cost is that the model cannot discover valid field names from the schema. The
mitigation is in every `fields` description: *call `get_recipe` on an existing
recipe first to see the exact attribute names this account uses.* That works
well in practice — reading live data is more reliable than reading the docs here.

**Do not "improve" this by hardcoding field names** without first reading a live
`get_recipe` response for the account you're targeting.

## Bodies are form-encoded, Rails-style

`formEncode()` flattens nested objects into `recipe[name]=x&recipe[tags][]=a`,
matching ReciPal's published examples. `as_json: true` switches to a JSON body
per call, because some endpoints may prefer it — this has not been exhaustively
mapped.

## Safety is enforced by environment, not by parameters

Mutating tools take `confirm: true`, and bulk tools default to `dry_run: true`.
These are useful and should be kept — but they are **supplied by the model**. An
assistant that has decided to delete something passes `confirm: true` in the same
call. They are a speed bump against a vague prompt, not a gate.

Real gates are environment variables, which only the operator can set:

```ts
const GATED = {
  delete_recipe:            { flag: "allowDelete", env: "RECIPAL_MCP_ALLOW_DELETE=1" },
  delete_recipe_ingredient: { flag: "allowDelete", env: "RECIPAL_MCP_ALLOW_DELETE=1" },
  recipal_request:          { flag: "enableRaw",   env: "RECIPAL_MCP_ENABLE_RAW=1" },
};
```

Gating is enforced twice: gated tools are filtered out of `tools/list` so the
model never sees them, and `handle()` refuses them anyway in case a client calls
a tool it was not offered. The refusal message names the exact environment
variable and states that a conversation cannot enable it — so the model reports
something actionable to the human instead of retrying.

To gate a new tool, add an entry to `GATED`. Nothing else needs changing.

## The API base URL is validated

`RECIPAL_API_BASE` is overridable for testing, but the API key is sent as an
`Authorization` header to whatever it points at — an unvalidated value is a
credential-exfiltration path. The server requires https and a `recipal.com` host,
and refuses to start otherwise unless `RECIPAL_MCP_ALLOW_CUSTOM_BASE=1` is also
set. Startup refusal (rather than a runtime error) means a misconfiguration is
loud and immediate.

## Rate limits are honoured, not assumed

ReciPal documents ~175,000 requests/week, 1,000/minute returning 429, and a
maximum of 5 concurrent label renders. `recipalFetch` retries 429 using
`Retry-After` when present and exponential backoff (capped at 30s) when not, up
to `RECIPAL_MCP_MAX_RETRIES`. It reads `X-RateLimit-*` headers, warns on stderr
below 100 remaining, and reports remaining quota in the error if it gives up.

**All bulk loops are strictly sequential** with a configurable inter-call delay.
Given the concurrent-render cap and the absence of any undo, sequential is the
only defensible default. Do not parallelise them.

## Bulk loops fail independently

`bulk_create_subrecipes` and `bulk_clone_and_swap` wrap each iteration in its own
try/catch and accumulate a per-entry result. One failure does not abort the rest,
and the returned report says exactly which entries failed and why — so a retry
targets only what broke. With no undo available, a half-completed run you can
diagnose beats an aborted run you cannot.

Dry-run output is designed to be *checkable*: `bulk_clone_and_swap` prints the
template's ingredient lines with their IDs so a human can confirm which line the
swap will target before anything is written.

## `bulk_clone_and_swap`, step by step

The workhorse. For each entry:

1. `POST /recipes/{template}/scale` with `scale_factor: 1` — a straight copy that
   carries label settings and tags forward.
2. `PUT /recipes/{new}` to set the name, because some copy paths append `(copy)`.
3. `GET /recipes/{new}/recipe_ingredients` and locate the line corresponding to
   the template's swap line, matching on `ingredient_id` and falling back to name.
4. **DELETE the line, then POST a new one.** Not `PUT`.
5. Verify the created line's `ingredient_id` matches what was requested, and fail
   the entry loudly if not.

Step 4 is not a stylistic choice. **`PUT /recipes/{id}/recipe_ingredients/{ri_id}`
silently discards `ingredient_id`** — it returns HTTP 200 with the original
ingredient still attached. Verified against the live API. A swap implemented with
`PUT` appears to succeed and does nothing, which is why step 5 exists.

## Documentation is generated

Hand-maintained tool docs in this project drifted badly enough to describe three
tools that never existed. `docs/TOOLS.md` is therefore generated: the script
boots the built server, calls `tools/list` twice (with and without the gate flags
set), and renders the result. CI regenerates it and fails if the committed copy
differs.

The consequence: **`docs/TOOLS.md` is never edited by hand.** Tool descriptions
live in the `TOOLS` array in `src/index.ts`, which is also what the model reads —
so writing a good description there improves both the docs and the model's
behaviour at once.

## Adding a tool

1. Add an entry to `TOOLS` in `src/index.ts`. Write the description for the model,
   not for a human skimming a table: say when to use it and what to call first.
2. Add a `case` to `handle()`. Route every response read through `unwrap()` or
   `extractRecords()`.
3. If it is destructive or unbounded, add it to `GATED`.
4. `npm run verify` — typecheck, build, regenerate docs, run tests.
5. Commit `docs/TOOLS.md` along with the code.

## Deliberately absent

- **Label PDF download to local disk.** Earlier planning docs described
  `download_label_pdf` and `bulk_download_labels`; they were never built. Only
  `request_label_render` and `get_recipe_label` exist. Writing files to disk from
  an MCP server needs a considered answer about where files land and who cleans
  them up.
- **Pagination helpers.** `list_recipes` caps at 100 per page; callers walk pages.
- **Caching.** Recipe data changes underneath you when someone uses the web UI.
- **Retries on anything but 429.** A 500 from a mutating endpoint might have
  partially applied; retrying blind could duplicate work.
