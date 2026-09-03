# Setup

## Prerequisites

- **Node.js 18 or newer.** Check with `node --version`. The server uses the global
  `fetch`, which landed in 18.
- **A ReciPal account with an active paid subscription.** API access is a paid
  feature. There is no free tier and no trial key.
- **An MCP client.** Claude Code, Claude Desktop, or anything else that speaks
  MCP over stdio.

## 1. Get your API key

In ReciPal, go to your account settings and open the **API access** section. Copy
the key.

Understand what you are copying: **this key has full read, write, and delete
access to every recipe and ingredient in your account.** ReciPal does not offer
read-only or scoped keys. Treat it like a password.

## 2. Install

### npx (recommended)

```bash
npx -y recipal-mcp-unofficial
```

This is the fastest way. The `--yes` / `-y` flag skips the npx install prompt.

### Clone and build (for development, or to run unpublished changes)

```bash
git clone https://github.com/RBV801/recipal-mcp-unofficial.git
cd recipal-mcp-unofficial
npm install
npm run build
```

That produces `build/index.js`. Confirm it works before wiring it into a client:

```bash
npm test
```

The tests run entirely offline — no API key, no network. If they pass, the
server builds and speaks the protocol correctly.

## 3. Register with your MCP client

The key can go in a `.env` file for local development (`cp .env.example .env`),
but MCP clients launch the server as a subprocess and do not read `.env`, so for
normal use the key goes in the client's own config.

### Claude Code

```bash
claude mcp add --transport stdio recipal-mcp-unofficial \
  --env RECIPAL_API_KEY=your_key_here \
  -- npx -y recipal-mcp-unofficial
```

Verify with `/mcp` — you should see `recipal-mcp-unofficial: connected`.

### Claude Desktop

Edit `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "recipal-mcp-unofficial": {
      "command": "npx",
      "args": ["-y", "recipal-mcp-unofficial"],
      "env": {
        "RECIPAL_API_KEY": "your_key_here"
      }
    }
  }
}
```

Restart the app completely. Config is read at launch.

### Any other client

Launch `npx -y recipal-mcp-unofficial` with `RECIPAL_API_KEY` in its environment
and connect over stdio. If you built from a clone, launch `node
/path/to/build/index.js` instead. There is nothing client-specific in the server.

## 4. Verify

Ask the assistant to list your recipes. You should get back a compact
`id: name [tags]` listing.

Expect **19 tools**. If you see 22, the optional flags below are set. If you see
1, you are running an old build — rerun `npm run build` and restart the client.

## 5. Optionally enable the gated tools

Three tools are hidden by default because they are irreversible or unbounded. See
the safety discussion in [SECURITY.md](../SECURITY.md) before enabling them.

| Variable | Enables |
|---|---|
| `RECIPAL_MCP_ALLOW_DELETE=1` | `delete_recipe`, `delete_recipe_ingredient` |
| `RECIPAL_MCP_ENABLE_RAW=1` | `recipal_request` |

Add them alongside `RECIPAL_API_KEY` in the same `env` block:

```json
"env": {
  "RECIPAL_API_KEY": "your_key_here",
  "RECIPAL_MCP_ALLOW_DELETE": "1"
}
```

Restart the client. The startup line on stderr reports what is exposed:

```
[recipal-mcp-unofficial] ready — v0.6.2, 19/20 tools exposed, base https://www.recipal.com/api/v1; disabled: recipal_request
```

## Upgrading

```bash
git pull
npm install
npm run build
```

Then restart the client — MCP clients cache the tool list until the server
restarts, so a rebuild alone will not change what the assistant can see. In
Claude Code, `claude mcp restart recipal-mcp-unofficial` is enough.

## Troubleshooting

**"RECIPAL_API_KEY is not set"** — the client is not passing the environment
through. Check the `env` block, and that you restarted the client.

**Server exits immediately, or the client shows it as failed** — run it by hand
to see the error: `RECIPAL_API_KEY=your_key node build/index.js`. It should print
a `ready` line and wait. Anything else is printed as a `FATAL` line explaining
what to fix.

**HTTP 401** — the key is wrong, the subscription lapsed, **or the ID is wrong/unowned.**
Requesting an ingredient or recipe your account does not own returns
`{"error":"NotAuthorized"}` — exactly the same response as an authentication failure.
If you are sure the key is correct, suspect the ID before you suspect your key.

**HTTP 429** — you hit the rate limit (ReciPal documents ~175,000/week and
1,000/minute). The server retries with backoff; if it gives up, the error
includes remaining quota and reset time. Raise `RECIPAL_MCP_MAX_RETRIES` or wait.

**Tool count wrong after editing the code** — `npm run build`, then restart the
client. Both steps, in that order.

**Only one tool appears** — you are running a stale `build/index.js` from before
the tools were added. `npm run build` again and check the timestamp.

**Something returned `undefined` IDs or an empty ingredient list** — that is the
signature of the response-envelope bug. It should be fixed, but if you have
extended the server, make sure new code paths use `unwrap()` / `extractRecords()`
rather than reading fields off the raw response. See [DESIGN.md](DESIGN.md).

**Nothing works and the client logs mention JSON parse errors** — something wrote
to stdout. stdout is the JSON-RPC channel; a single `console.log` anywhere in the
server corrupts it. Use `console.error`.

**The tool list looks stale after upgrading** — npx may be serving a cached
version. Force a fresh fetch with `npx -y recipal-mcp-unofficial@latest`.
