# recipal-mcp-unofficial

An [MCP](https://modelcontextprotocol.io) server for the [ReciPal](https://www.recipal.com) nutrition-label API. It lets an AI assistant read and edit your recipes, ingredients, and subrecipes directly — including bulk operations that would take hours in the web UI.

> **Unofficial.** Not affiliated with, endorsed by, or supported by ReciPal. Built by users of
> the product against its public API.
>
> **Interim project — this repository will be archived.** ReciPal is building an official MCP
> server. When theirs ships, this one will be updated to point at it and then archived read-only.
> Don't build anything load-bearing on it. See [SUNSET.md](SUNSET.md).

**You need an active paid ReciPal subscription.** API access is a paid feature; the key comes from your account settings under *API access*. Without one, this server cannot do anything.

## What it's for

ReciPal's web UI is fine for editing one recipe. It is painful when you need to do the same thing to forty of them — fix a serving size across a whole catalog, rename ingredients that came in with `(copy)` suffixes, or build a family of product variants that differ by one ingredient. This server exposes the API so an assistant can do that work in a loop, with a dry run first.

The tool that earns its keep is `bulk_clone_and_swap`: take one fully-configured recipe as a template, clone it N times, and swap a single ingredient in each clone. Label settings, tags, and serving sizes carry forward, so the clones come out consistent.

## Scope and distribution

Deliberately narrow, and it will stay that way:

- **Source you clone and build.** There is no one-click plugin bundle, no `npx` package, and no
  listing in any MCP directory or marketplace. That is a commitment made to ReciPal, not an
  oversight or a to-do item.
- **Not published to npm.** The `package.json` is marked `private` on purpose.
- **Named `recipal-mcp-unofficial`** at ReciPal's request, so it cannot be mistaken for their
  official server.

Pull requests that add packaged distribution, marketplace submissions, or a friendlier consumer
install path will be declined. See [CONTRIBUTING.md](CONTRIBUTING.md) for what is welcome.

## Install

Requires Node.js 18 or newer.

```bash
git clone https://github.com/BlackBlack/recipal-mcp-unofficial.git
cd recipal-mcp-unofficial
npm install
npm run build
```

Then register it with your MCP client. For Claude Code:

```bash
claude mcp add --transport stdio recipal-mcp-unofficial \
  --env RECIPAL_API_KEY=your_key_here \
  -- node /absolute/path/to/recipal-mcp-unofficial/build/index.js
```

For Claude Desktop, add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "recipal-mcp-unofficial": {
      "command": "node",
      "args": ["/absolute/path/to/recipal-mcp-unofficial/build/index.js"],
      "env": { "RECIPAL_API_KEY": "your_key_here" }
    }
  }
}
```

Restart the client, then ask it to list your recipes. You should see 19 tools available. Full walkthrough in [docs/SETUP.md](docs/SETUP.md).

## ⚠️ Read this before pointing it at a catalog you care about

**The `confirm: true` and `dry_run` guards are supplied by the model, not by you.** They stop a vaguely-worded prompt from causing damage. They do **not** stop a determined or confused agent — an assistant that decides to delete a recipe will pass `confirm: true` in the same call. **ReciPal has no undo.**

Because of that, the genuinely destructive tools are **off by default**. Turning them on is a deliberate act by the person running the server, not something a conversation can do:

| Environment variable | Enables | Why it's gated |
|---|---|---|
| `RECIPAL_MCP_ALLOW_DELETE=1` | `delete_recipe`, `delete_recipe_ingredient` | Permanent data loss, no undo |
| `RECIPAL_MCP_ENABLE_RAW=1` | `recipal_request` | Can call any endpoint with any method |

Everything else — all reads, and the ordinary create/update tools — works out of the box. The bulk tools are always available but default to `dry_run: true`, and refuse to execute unless the caller passes both `dry_run: false` and `confirm: true`.

Recommended practice regardless: **work against a throwaway recipe first.** Several endpoints behave differently from what the docs suggest (see Known limitations).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `RECIPAL_API_KEY` | — | **Required.** From ReciPal account settings → API access |
| `RECIPAL_MCP_ALLOW_DELETE` | off | Expose the two delete tools |
| `RECIPAL_MCP_ENABLE_RAW` | off | Expose `recipal_request` |
| `RECIPAL_MCP_DEBUG` | off | Log full request bodies to stderr. Bodies contain recipe data and your client probably logs stderr to disk, so leave off routinely |
| `RECIPAL_MCP_MAX_RETRIES` | `3` | Retries on HTTP 429 |
| `RECIPAL_API_BASE` | `https://www.recipal.com/api/v1` | Override the endpoint. Must be https and a `recipal.com` host |
| `RECIPAL_MCP_ALLOW_CUSTOM_BASE` | off | Permit a non-`recipal.com` base. Your API key is sent to whatever it points at, so this is deliberately awkward |

See [.env.example](.env.example).

## Tools

22 tools total, 19 exposed by default. Generated reference with every parameter: **[docs/TOOLS.md](docs/TOOLS.md)**.

| Group | Tools |
|---|---|
| Read | `list_recipes`, `get_recipe`, `get_recipe_nutrition`, `list_recipe_ingredients`, `get_recipe_ingredient`, `list_ingredients`, `get_ingredient`, `get_recipe_label` |
| Recipe writes | `create_recipe`, `create_recipe_shortcut`, `update_recipe`, `scale_recipe`, `create_subrecipe`, `delete_recipe`† |
| Ingredient-line writes | `create_recipe_ingredient`, `update_recipe_ingredient`, `delete_recipe_ingredient`†, `update_ingredient` |
| Labels | `request_label_render` |
| Bulk | `bulk_create_subrecipes`, `bulk_clone_and_swap` |
| Escape hatch | `recipal_request`† |

† disabled by default.

Write tools take an open `fields` object rather than a fixed parameter list. ReciPal's published docs truncate before the full recipe attribute list, so hardcoding field names would have meant guessing; instead `fields` is passed straight through, Rails-style form-encoded (`recipe[name]=...`). Undocumented attributes work without a code change. Set `as_json: true` if an endpoint prefers JSON.

**Read a real recipe before writing to one.** `get_recipe` on an existing recipe shows the exact attribute names your account uses.

## Known limitations

These are real, verified against the live API, and worth knowing before you build on this:

- **`create_recipe_shortcut` does not work.** It returns HTTP 422 for every ingredients-array format tried. ReciPal's docs truncate before the parameter list, so the correct shape is unknown. Use `create_recipe` + `create_recipe_ingredient`, or `scale_recipe` to clone a configured template. The tool is left in place so the shape can be discovered — if you work it out, please open a PR.
- **`PUT /recipe_ingredients/{id}` silently ignores `ingredient_id`.** It returns HTTP 200 with the original ingredient still attached. Swapping one ingredient for another must be done as delete-then-create, which is what `bulk_clone_and_swap` does internally.
- **ReciPal double-wraps almost every response** — `{recipe: {recipe_ingredients: [{recipe_ingredient: {…}}]}}`. Reading fields off the outer envelope yields `undefined` with no error. If you extend this server, use the existing `unwrap()` / `extractRecords()` helpers.
- **Parameter names for `scale_recipe` and `create_subrecipe` are not published.** They work via pass-through `fields`, but run each once against a throwaway recipe and read the response before looping.
- **The docs list `/recipes/{id}/scale` as `PUT`; `POST` is what actually works.** Don't "fix" this without testing.
- **No pagination helper.** `list_recipes` caps at 100 per page; walk pages yourself.

## Rate limits

ReciPal documents roughly 175,000 requests/week, 1,000/minute (HTTP 429 beyond that), and a maximum of 5 concurrent label renders. This server honours 429 with `Retry-After` and exponential backoff, warns on stderr when fewer than 100 requests remain, and runs every bulk loop strictly sequentially with a configurable delay. Do not parallelise label renders.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm run build       # -> build/index.js
npm test            # offline smoke tests, no API key or network needed
npm run gen:docs    # regenerate docs/TOOLS.md from the running server
npm run verify      # all of the above
```

`docs/TOOLS.md` is generated by booting the built server and asking it for its own tool list, so the reference cannot drift from the code. CI fails if it's stale. If you add or change a tool, run `npm run build && npm run gen:docs` and commit the result.

Contributions welcome within the scope above — start with [CONTRIBUTING.md](CONTRIBUTING.md), then [docs/TESTING.md](docs/TESTING.md) for how to verify changes against a live account, and [docs/DESIGN.md](docs/DESIGN.md) for how the pieces fit.

## License

[Apache-2.0](LICENSE).

"ReciPal" is a trademark of its owner and is used here only to describe what this software talks to.
