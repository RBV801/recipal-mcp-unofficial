#!/usr/bin/env node
/**
 * recipal-mcp-unofficial — an unofficial MCP server for the ReciPal API
 * https://www.recipal.com/api-docs
 *
 * Not affiliated with, endorsed by, or supported by ReciPal.
 *
 * Design notes:
 *  - Write tools take an open `fields` object rather than a fixed parameter list.
 *    The ReciPal recipe schema is not fully published — the API docs truncate
 *    before the full attribute list — so passing fields through means new and
 *    undocumented attributes work without a code change.
 *  - Bodies are sent Rails-style form-encoded (recipe[name]=...) by default,
 *    which is what the published examples use. Set `as_json: true` to send JSON.
 *  - ReciPal double-wraps almost every response. See unwrap() / extractRecords().
 *    Getting this wrong is silent, not loud.
 *  - Bulk loops are strictly sequential. The API caps concurrent label renders
 *    at 5, and there is no undo for anything.
 *  - All logging goes to stderr. stdout is the JSON-RPC channel — a single
 *    console.log anywhere in this file would corrupt the protocol stream.
 *
 * SAFETY — read this before pointing it at a catalog you care about:
 *  The `confirm: true` / `dry_run` guards on mutating tools are supplied by the
 *  *model*, not by a human. They stop a vague prompt from causing damage; they
 *  do not stop a determined or confused agent. The genuinely destructive tools
 *  are therefore off unless a human turns them on at install time:
 *
 *    RECIPAL_API_KEY                  (required)
 *    RECIPAL_MCP_ALLOW_DELETE=1       enables delete_recipe, delete_recipe_ingredient
 *    RECIPAL_MCP_ENABLE_RAW=1         enables recipal_request (arbitrary API calls)
 *    RECIPAL_MCP_DEBUG=1              log full request bodies to stderr
 *    RECIPAL_API_BASE                 override API base URL (must be https + *.recipal.com)
 *    RECIPAL_MCP_ALLOW_CUSTOM_BASE=1  permit a non-recipal.com base URL
 *    RECIPAL_MCP_MAX_RETRIES          429 retry attempts (default 3)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

const VERSION = "0.5.0";

const log = (...a: unknown[]) => console.error("[recipal-mcp-unofficial]", ...a);

function fatal(msg: string): never {
  console.error(`[recipal-mcp-unofficial] FATAL: ${msg}`);
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

const FLAGS = {
  allowDelete: process.env.RECIPAL_MCP_ALLOW_DELETE === "1",
  enableRaw: process.env.RECIPAL_MCP_ENABLE_RAW === "1",
  debug: process.env.RECIPAL_MCP_DEBUG === "1",
  allowCustomBase: process.env.RECIPAL_MCP_ALLOW_CUSTOM_BASE === "1",
};

const MAX_RETRIES = (() => {
  const n = Number(process.env.RECIPAL_MCP_MAX_RETRIES ?? 3);
  return Number.isFinite(n) && n >= 0 ? Math.min(10, Math.floor(n)) : 3;
})();

const DEFAULT_API_BASE = "https://www.recipal.com/api/v1";

/**
 * The API key is sent as an Authorization header to whatever API_BASE points at,
 * so an unvalidated base URL from the environment is a credential-exfiltration
 * path. Require https, and require a recipal.com host unless the operator has
 * explicitly opted out.
 */
const API_BASE = (() => {
  const raw = process.env.RECIPAL_API_BASE?.trim();
  if (!raw) return DEFAULT_API_BASE;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return fatal(`RECIPAL_API_BASE is not a valid URL: ${raw}`);
  }
  if (parsed.protocol !== "https:") {
    return fatal(`RECIPAL_API_BASE must use https (got ${parsed.protocol}).`);
  }
  const host = parsed.hostname.toLowerCase();
  const isRecipal = host === "recipal.com" || host.endsWith(".recipal.com");
  if (!isRecipal && !FLAGS.allowCustomBase) {
    return fatal(
      `RECIPAL_API_BASE host "${host}" is not a recipal.com host. Your API key would ` +
        `be sent there. Set RECIPAL_MCP_ALLOW_CUSTOM_BASE=1 if this is intentional.`
    );
  }
  return raw.replace(/\/+$/, "");
})();

const API_KEY = process.env.RECIPAL_API_KEY;
if (!API_KEY) {
  fatal(
    "RECIPAL_API_KEY is not set. Copy .env.example, add your key from the ReciPal " +
      "account settings page (API access requires an active paid subscription), and " +
      "pass it through your MCP client config."
  );
}

/** Tools that stay hidden unless a human enabled them at install time. */
const GATED: Record<string, { flag: keyof typeof FLAGS; env: string; why: string }> = {
  delete_recipe: {
    flag: "allowDelete",
    env: "RECIPAL_MCP_ALLOW_DELETE=1",
    why: "permanently deletes a recipe; ReciPal has no undo",
  },
  delete_recipe_ingredient: {
    flag: "allowDelete",
    env: "RECIPAL_MCP_ALLOW_DELETE=1",
    why: "permanently removes an ingredient line; ReciPal has no undo",
  },
  recipal_request: {
    flag: "enableRaw",
    env: "RECIPAL_MCP_ENABLE_RAW=1",
    why: "can call any ReciPal endpoint with any method",
  },
};

const isEnabled = (name: string): boolean => {
  const g = GATED[name];
  return !g || FLAGS[g.flag] === true;
};

/* ------------------------------------------------------------------ *
 * HTTP layer
 * ------------------------------------------------------------------ */

type Json = Record<string, unknown>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Flatten {recipe:{name:"x",tags:["a"]}} -> recipe[name]=x&recipe[tags][]=a */
function formEncode(obj: Json, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item !== null && typeof item === "object") {
          out.push(...formEncode(item as Json, `${key}[]`));
        } else {
          out.push(`${encodeURIComponent(`${key}[]`)}=${encodeURIComponent(String(item))}`);
        }
      }
    } else if (typeof v === "object") {
      out.push(...formEncode(v as Json, key));
    } else {
      out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
    }
  }
  return out;
}

interface FetchOpts {
  method?: string;
  body?: Json;
  asJson?: boolean;
  query?: Json;
}

/** Last seen rate-limit state, surfaced in errors and on low remaining quota. */
let rateLimit: { limit?: string; remaining?: string; reset?: string } = {};

function readRateLimit(res: Response): void {
  const limit = res.headers.get("x-ratelimit-limit") ?? undefined;
  const remaining = res.headers.get("x-ratelimit-remaining") ?? undefined;
  const reset = res.headers.get("x-ratelimit-reset") ?? undefined;
  if (limit || remaining || reset) rateLimit = { limit, remaining, reset };
  const n = Number(remaining);
  if (Number.isFinite(n) && n > 0 && n <= 100) {
    log(`WARNING: only ${n} API requests remaining (limit ${limit ?? "?"}, reset ${reset ?? "?"})`);
  }
}

/**
 * ReciPal documents a weekly cap of 175,000 requests, 1,000/minute returning
 * HTTP 429, and a maximum of 5 concurrent label renders. Honour 429 with
 * Retry-After, falling back to exponential backoff.
 */
async function recipalFetch(path: string, opts: FetchOpts = {}): Promise<unknown> {
  const { method = "GET", body, asJson = false, query } = opts;

  let url = `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`;
  if (query && Object.keys(query).length) {
    url += (url.includes("?") ? "&" : "?") + formEncode(query).join("&");
  }

  const headers: Record<string, string> = {
    Authorization: `Token token=${API_KEY}`,
    Accept: "application/json",
    "User-Agent": `recipal-mcp-unofficial/${VERSION}`,
  };

  let payload: string | undefined;
  if (body && Object.keys(body).length) {
    if (asJson) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    } else {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      payload = formEncode(body).join("&");
    }
  }

  // Request bodies contain recipe data. Only log them when explicitly asked.
  if (FLAGS.debug) {
    log(`${method} ${url}${payload ? ` body=${payload.slice(0, 400)}` : ""}`);
  } else {
    log(`${method} ${path}`);
  }

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { method, headers, body: payload });
    readRateLimit(res);

    if (res.status === 429 && attempt < MAX_RETRIES) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(30_000, 1000 * 2 ** attempt);
      log(`429 rate limited; retrying in ${waitMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await sleep(waitMs);
      continue;
    }

    const text = await res.text();

    if (!res.ok) {
      const rl =
        res.status === 429
          ? ` (rate limit ${rateLimit.remaining ?? "?"}/${rateLimit.limit ?? "?"} remaining,` +
            ` resets ${rateLimit.reset ?? "?"}; gave up after ${MAX_RETRIES} retries)`
          : "";
      throw new Error(
        `ReciPal ${method} ${path} -> HTTP ${res.status} ${res.statusText}${rl}\n${text.slice(0, 2000)}`
      );
    }
    if (!text.trim()) return { ok: true, status: res.status };
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  }
}

/* ------------------------------------------------------------------ *
 * Tool definitions
 * ------------------------------------------------------------------ */

const S = {
  str: { type: "string" as const },
  int: { type: "integer" as const },
  num: { type: "number" as const },
  bool: { type: "boolean" as const },
  obj: { type: "object" as const, additionalProperties: true },
};

const FIELDS_DESC =
  "Open key/value object of attributes. Keys are passed straight through to the " +
  "ReciPal API namespaced under the resource (e.g. {name, serving_size_quantity, " +
  "serving_size_unit, servings_per_container, package_yield_quantity, " +
  "package_yield_unit, tags}). Call get_recipe on an existing recipe first to see " +
  "the exact attribute names this account uses.";

const TOOLS: Tool[] = [
  /* ---------- read ---------- */
  {
    name: "list_recipes",
    description:
      "List recipes from ReciPal with IDs, names, and tags. Paginated; per_page max 100.",
    inputSchema: {
      type: "object",
      properties: {
        page: { ...S.int, description: "1-based page number (default 1)." },
        per_page: { ...S.int, description: "Items per page (default 20, max 100)." },
      },
    },
  },
  {
    name: "get_recipe",
    description:
      "Get one recipe in full, including nutrition, serving size, package yield, tags " +
      "and label settings. Use this to read a template recipe's exact settings before " +
      "cloning it.",
    inputSchema: {
      type: "object",
      properties: { recipe_id: { ...S.str, description: "ReciPal recipe ID." } },
      required: ["recipe_id"],
    },
  },
  {
    name: "get_recipe_nutrition",
    description: "Get only the nutrition sub-object for a recipe.",
    inputSchema: {
      type: "object",
      properties: { recipe_id: S.str },
      required: ["recipe_id"],
    },
  },
  {
    name: "list_recipe_ingredients",
    description:
      "List every ingredient line on a recipe, with recipe_ingredient IDs, " +
      "ingredient IDs, quantities, units and total_grams.",
    inputSchema: {
      type: "object",
      properties: { recipe_id: S.str },
      required: ["recipe_id"],
    },
  },
  {
    name: "get_recipe_ingredient",
    description: "Get one ingredient line on a recipe.",
    inputSchema: {
      type: "object",
      properties: { recipe_id: S.str, recipe_ingredient_id: S.str },
      required: ["recipe_id", "recipe_ingredient_id"],
    },
  },
  {
    name: "list_ingredients",
    description:
      "List the account's ingredient library. Subrecipes appear here once created, " +
      "which is how you find the ingredient_id needed to add a subrecipe to another recipe.",
    inputSchema: {
      type: "object",
      properties: {
        page: S.int,
        per_page: { ...S.int, description: "Default 20, max 100." },
        search: { ...S.str, description: "Optional name filter, if supported." },
      },
    },
  },
  {
    name: "get_ingredient",
    description: "Get one ingredient with its full nutrition data and available units.",
    inputSchema: {
      type: "object",
      properties: { ingredient_id: S.str },
      required: ["ingredient_id"],
    },
  },

  /* ---------- recipe writes ---------- */
  {
    name: "create_recipe",
    description:
      "Create a new empty recipe. POST /recipes. Prefer scale_recipe (clone a " +
      "fully-configured template) when you need label settings to match existing recipes.",
    inputSchema: {
      type: "object",
      properties: {
        fields: { ...S.obj, description: FIELDS_DESC },
        as_json: { ...S.bool, description: "Send JSON instead of form encoding." },
      },
      required: ["fields"],
    },
  },
  {
    name: "create_recipe_shortcut",
    description:
      "Create a complete recipe with its ingredients in one request. POST /recipes/shortcut. " +
      "KNOWN ISSUE: this returns HTTP 422 for every ingredients-array format tried so far. " +
      "ReciPal's published docs truncate before the parameter list, so the correct shape is " +
      "unknown. Prefer create_recipe + create_recipe_ingredient, or scale_recipe to clone a " +
      "configured template. Left in place so the shape can be discovered.",
    inputSchema: {
      type: "object",
      properties: {
        fields: { ...S.obj, description: FIELDS_DESC + " Include the ingredients array." },
        as_json: S.bool,
      },
      required: ["fields"],
    },
  },
  {
    name: "update_recipe",
    description: "Update a recipe's attributes. PUT /recipes/{id}.",
    inputSchema: {
      type: "object",
      properties: {
        recipe_id: S.str,
        fields: { ...S.obj, description: FIELDS_DESC },
        as_json: S.bool,
      },
      required: ["recipe_id", "fields"],
    },
  },
  {
    name: "scale_recipe",
    description:
      "Copy (and optionally scale) an existing recipe. POST /recipes/{id}/scale. " +
      "This is the copy-and-swap primitive: cloning a configured template carries its " +
      "label settings and tags forward, so you only replace one ingredient afterward. " +
      "Pass a scale factor of 1 for a straight copy.",
    inputSchema: {
      type: "object",
      properties: {
        recipe_id: { ...S.str, description: "Recipe to copy." },
        fields: {
          ...S.obj,
          description:
            "e.g. {name: 'New Recipe Name', scale_factor: 1}. Parameter names for this " +
            "endpoint are not published; run once against a throwaway recipe to confirm.",
        },
        as_json: S.bool,
      },
      required: ["recipe_id"],
    },
  },
  {
    name: "create_subrecipe",
    description:
      "Flag an existing recipe as a subrecipe so it becomes usable as an ingredient in " +
      "other recipes. POST /recipes/{id}/create_subrecipe. Returns the new ingredient " +
      "record — capture its ingredient_id, that is what you add to other recipes.",
    inputSchema: {
      type: "object",
      properties: {
        recipe_id: S.str,
        fields: { ...S.obj, description: "Optional attributes (e.g. name)." },
        as_json: S.bool,
      },
      required: ["recipe_id"],
    },
  },
  {
    name: "delete_recipe",
    description:
      "Delete a recipe. DESTRUCTIVE and irreversible — requires confirm:true, and the " +
      "server must have been started with RECIPAL_MCP_ALLOW_DELETE=1.",
    inputSchema: {
      type: "object",
      properties: {
        recipe_id: S.str,
        confirm: { ...S.bool, description: "Must be true." },
      },
      required: ["recipe_id", "confirm"],
    },
  },

  /* ---------- ingredient-line writes ---------- */
  {
    name: "create_recipe_ingredient",
    description:
      "Add an ingredient line to a recipe. POST /recipes/{id}/recipe_ingredients. " +
      "Accepts ingredient_id (required) plus unit + quantity, or total_grams.",
    inputSchema: {
      type: "object",
      properties: {
        recipe_id: S.str,
        fields: {
          ...S.obj,
          description:
            "{ingredient_id (required), unit?, quantity?, waste?, total_grams?}. " +
            "unit must be one of the ingredient's available units.",
        },
        as_json: S.bool,
      },
      required: ["recipe_id", "fields"],
    },
  },
  {
    name: "update_recipe_ingredient",
    description:
      "Update one ingredient line. PUT /recipes/{id}/recipe_ingredients/{ri_id}. " +
      "NOTE: this endpoint silently ignores ingredient_id — it returns 200 with the " +
      "original ingredient still attached. To swap one ingredient for another you must " +
      "delete the line and create a new one.",
    inputSchema: {
      type: "object",
      properties: {
        recipe_id: S.str,
        recipe_ingredient_id: S.str,
        fields: {
          ...S.obj,
          description: "{unit?, quantity?, waste?, total_grams?} — ingredient_id is ignored.",
        },
        as_json: S.bool,
      },
      required: ["recipe_id", "recipe_ingredient_id", "fields"],
    },
  },
  {
    name: "delete_recipe_ingredient",
    description:
      "Remove an ingredient line from a recipe. DESTRUCTIVE — requires confirm:true, and " +
      "the server must have been started with RECIPAL_MCP_ALLOW_DELETE=1.",
    inputSchema: {
      type: "object",
      properties: {
        recipe_id: S.str,
        recipe_ingredient_id: S.str,
        confirm: S.bool,
      },
      required: ["recipe_id", "recipe_ingredient_id", "confirm"],
    },
  },
  {
    name: "update_ingredient",
    description:
      "Update an ingredient in the library. PUT /ingredients/{id}. Use for renaming " +
      "(e.g. stripping '(copy)' suffixes).",
    inputSchema: {
      type: "object",
      properties: {
        ingredient_id: S.str,
        fields: { ...S.obj, description: "e.g. {name: 'Vanilla Concentrate'}" },
        as_json: S.bool,
      },
      required: ["ingredient_id", "fields"],
    },
  },

  /* ---------- labels ---------- */
  {
    name: "get_recipe_label",
    description: "Get a recipe's label data / render status. GET /recipes/{id}/label.",
    inputSchema: {
      type: "object",
      properties: { recipe_id: S.str },
      required: ["recipe_id"],
    },
  },
  {
    name: "request_label_render",
    description:
      "Request a label PDF/PNG render. POST /recipes/{id}/label. Renders take several " +
      "seconds; poll get_recipe_label for status. ReciPal caps concurrent renders at 5.",
    inputSchema: {
      type: "object",
      properties: {
        recipe_id: S.str,
        fields: { ...S.obj, description: "e.g. {format: 'pdf'}" },
        as_json: S.bool,
      },
      required: ["recipe_id"],
    },
  },

  /* ---------- bulk ---------- */
  {
    name: "bulk_create_subrecipes",
    description:
      "Flag many recipes as subrecipes, sequentially. Defaults to dry_run:true — returns " +
      "the plan without touching anything. Set dry_run:false AND confirm:true to execute. " +
      "Returns a per-recipe success/failure report including the new ingredient_ids.",
    inputSchema: {
      type: "object",
      properties: {
        recipe_ids: { type: "array", items: S.str, description: "Recipe IDs to flag." },
        dry_run: { ...S.bool, description: "Default true." },
        confirm: { ...S.bool, description: "Must be true to execute." },
        delay_ms: { ...S.int, description: "Pause between calls (default 400)." },
      },
      required: ["recipe_ids"],
    },
  },
  {
    name: "bulk_clone_and_swap",
    description:
      "The copy-and-swap loop. For each entry: clone template_recipe_id via scale_recipe, " +
      "rename it, then replace the designated ingredient line with a different " +
      "ingredient_id. Runs sequentially and independently per entry, so one failure does " +
      "not poison the rest. Defaults to dry_run:true.",
    inputSchema: {
      type: "object",
      properties: {
        template_recipe_id: {
          ...S.str,
          description: "The fully-configured template recipe to clone from.",
        },
        swap_recipe_ingredient_id: {
          ...S.str,
          description:
            "The recipe_ingredient line ID ON THE TEMPLATE that should be replaced. " +
            "The clone's corresponding line is located by matching ingredient_id.",
        },
        entries: {
          type: "array",
          description: "One entry per new recipe.",
          items: {
            type: "object",
            properties: {
              name: { ...S.str, description: "Name for the new recipe." },
              ingredient_id: {
                ...S.str,
                description: "Ingredient (often a subrecipe) to swap in.",
              },
              fields: { ...S.obj, description: "Optional extra recipe attributes." },
              ingredient_fields: {
                ...S.obj,
                description:
                  "Optional overrides for the swapped line (unit, quantity, total_grams).",
              },
            },
            required: ["name", "ingredient_id"],
          },
        },
        dry_run: { ...S.bool, description: "Default true." },
        confirm: { ...S.bool, description: "Must be true to execute." },
        delay_ms: S.int,
      },
      required: ["template_recipe_id", "swap_recipe_ingredient_id", "entries"],
    },
  },

  /* ---------- escape hatch ---------- */
  {
    name: "recipal_request",
    description:
      "Call any ReciPal API endpoint directly. Use this to discover undocumented fields " +
      "or hit endpoints this server does not wrap yet. Mutating methods " +
      "(POST/PUT/PATCH/DELETE) require confirm:true, and the server must have been " +
      "started with RECIPAL_MCP_ENABLE_RAW=1.",
    inputSchema: {
      type: "object",
      properties: {
        method: { ...S.str, description: "GET, POST, PUT, PATCH or DELETE." },
        path: { ...S.str, description: "Path after /api/v1, e.g. '/recipes/123456'." },
        query: { ...S.obj, description: "Query-string params." },
        body: { ...S.obj, description: "Request body, form-encoded unless as_json." },
        as_json: S.bool,
        confirm: { ...S.bool, description: "Required for mutating methods." },
      },
      required: ["method", "path"],
    },
  },
];

const enabledTools = (): Tool[] => TOOLS.filter((t) => isEnabled(t.name));

/* ------------------------------------------------------------------ *
 * Response shape helpers
 * ------------------------------------------------------------------ */

const clampPer = (n: unknown) =>
  Math.min(100, Math.max(1, Number.isFinite(Number(n)) ? Number(n) : 20));

/**
 * ReciPal double-wraps almost everything:
 *   {recipe: {recipe_ingredients: [{recipe_ingredient: {...}}, ...]}}
 *   [{recipe: {...}}, {recipe: {...}}]
 * unwrap() strips a single-key envelope; extractRecords walks both levels.
 * Getting this wrong is silent — the array comes back empty and callers think
 * the recipe has no ingredients.
 */
function unwrap(o: unknown): Json {
  if (!o || typeof o !== "object" || Array.isArray(o)) return (o ?? {}) as Json;
  const obj = o as Json;
  const keys = Object.keys(obj);
  if (keys.length === 1) {
    const inner = obj[keys[0]];
    if (inner && typeof inner === "object" && !Array.isArray(inner)) return inner as Json;
  }
  return obj;
}

/**
 * Pull a list of records out of a ReciPal collection response, whatever envelope
 * it arrived in, and unwrap each element. Used for both recipe lists and
 * ingredient-line lists.
 */
function extractRecords(payload: unknown): Array<Json> {
  let node: unknown = payload;
  // descend through up to 3 envelope layers looking for the array
  for (let depth = 0; depth < 3; depth++) {
    if (Array.isArray(node)) break;
    if (!node || typeof node !== "object") return [];
    const obj = node as Json;
    let found: unknown;
    for (const key of ["recipe_ingredients", "ingredients", "recipes", "data", "results"]) {
      if (Array.isArray(obj[key])) {
        found = obj[key];
        break;
      }
    }
    if (found) {
      node = found;
      break;
    }
    const keys = Object.keys(obj);
    if (keys.length === 1) {
      node = obj[keys[0]];
      continue;
    }
    return [];
  }
  if (!Array.isArray(node)) return [];
  // each element may itself be {recipe_ingredient: {...}} or {recipe: {...}}
  return (node as unknown[]).map((el) => unwrap(el));
}

function pickId(o: Json | undefined, ...keys: string[]): string | undefined {
  if (!o) return undefined;
  for (const k of keys) {
    const v = o[k];
    if (v !== undefined && v !== null) return String(v);
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * Handlers
 * ------------------------------------------------------------------ */

async function handle(name: string, args: Json): Promise<unknown> {
  const gate = GATED[name];
  if (gate && FLAGS[gate.flag] !== true) {
    throw new Error(
      `Tool "${name}" is disabled because it ${gate.why}. The person running this ` +
        `server must set ${gate.env} in the MCP server environment and restart it. ` +
        `This cannot be enabled from a conversation.`
    );
  }

  const asJson = Boolean(args.as_json);
  const fields = (args.fields as Json) ?? {};

  switch (name) {
    /* ---- read ---- */
    case "list_recipes": {
      const data = await recipalFetch("/recipes", {
        query: { page: args.page ?? 1, per_page: clampPer(args.per_page) },
      });
      const list = extractRecords(data);
      if (list.length) {
        // Compact "id: name [tags]" output.
        // NOTE: rows arrive as {recipe: {...}}; extractRecords unwraps them.
        // Reading r.id/r.name off the envelope yields "undefined: undefined".
        return list
          .map((r) => {
            const id = pickId(r, "id", "recipe_id");
            const t = r.tags;
            const tags = Array.isArray(t)
              ? t
              : typeof t === "string" && t.trim()
                ? t.split(",").map((s) => s.trim())
                : [];
            return `${id}: ${r.name ?? "(unnamed)"}${tags.length ? ` [${tags.join(", ")}]` : ""}`;
          })
          .join("\n");
      }
      return data;
    }
    case "get_recipe":
      return recipalFetch(`/recipes/${args.recipe_id}`);
    case "get_recipe_nutrition": {
      // response is {recipe:{nutrition:{...}}} — must unwrap before reading
      const r = unwrap(await recipalFetch(`/recipes/${args.recipe_id}`));
      return r?.nutrition ?? r?.nutrition_facts ?? r;
    }
    case "list_recipe_ingredients":
      return recipalFetch(`/recipes/${args.recipe_id}/recipe_ingredients`);
    case "get_recipe_ingredient":
      return recipalFetch(
        `/recipes/${args.recipe_id}/recipe_ingredients/${args.recipe_ingredient_id}`
      );
    case "list_ingredients":
      return recipalFetch("/ingredients", {
        query: {
          page: args.page ?? 1,
          per_page: clampPer(args.per_page),
          ...(args.search ? { search: args.search } : {}),
        },
      });
    case "get_ingredient":
      return recipalFetch(`/ingredients/${args.ingredient_id}`);
    case "get_recipe_label":
      return recipalFetch(`/recipes/${args.recipe_id}/label`);

    /* ---- writes ---- */
    case "create_recipe":
      return recipalFetch("/recipes", { method: "POST", body: { recipe: fields }, asJson });
    case "create_recipe_shortcut":
      return recipalFetch("/recipes/shortcut", {
        method: "POST",
        body: { recipe: fields },
        asJson,
      });
    case "update_recipe":
      return recipalFetch(`/recipes/${args.recipe_id}`, {
        method: "PUT",
        body: { recipe: fields },
        asJson,
      });
    case "scale_recipe":
      // ReciPal's docs render this endpoint as PUT, but POST is what actually
      // works against the live API. Do not "correct" this without testing.
      return recipalFetch(`/recipes/${args.recipe_id}/scale`, {
        method: "POST",
        body: Object.keys(fields).length ? { recipe: fields } : {},
        asJson,
      });
    case "create_subrecipe":
      return recipalFetch(`/recipes/${args.recipe_id}/create_subrecipe`, {
        method: "POST",
        body: Object.keys(fields).length ? { recipe: fields } : {},
        asJson,
      });
    case "delete_recipe": {
      if (args.confirm !== true) throw new Error("Refusing to delete: confirm must be true.");
      return recipalFetch(`/recipes/${args.recipe_id}`, { method: "DELETE" });
    }
    case "create_recipe_ingredient":
      return recipalFetch(`/recipes/${args.recipe_id}/recipe_ingredients`, {
        method: "POST",
        body: { recipe_ingredient: fields },
        asJson,
      });
    case "update_recipe_ingredient":
      return recipalFetch(
        `/recipes/${args.recipe_id}/recipe_ingredients/${args.recipe_ingredient_id}`,
        { method: "PUT", body: { recipe_ingredient: fields }, asJson }
      );
    case "delete_recipe_ingredient": {
      if (args.confirm !== true)
        throw new Error("Refusing to delete ingredient line: confirm must be true.");
      return recipalFetch(
        `/recipes/${args.recipe_id}/recipe_ingredients/${args.recipe_ingredient_id}`,
        { method: "DELETE" }
      );
    }
    case "update_ingredient":
      return recipalFetch(`/ingredients/${args.ingredient_id}`, {
        method: "PUT",
        body: { ingredient: fields },
        asJson,
      });
    case "request_label_render":
      return recipalFetch(`/recipes/${args.recipe_id}/label`, {
        method: "POST",
        body: Object.keys(fields).length ? fields : { format: "pdf" },
        asJson,
      });

    /* ---- bulk ---- */
    case "bulk_create_subrecipes": {
      const ids = (args.recipe_ids as string[]) ?? [];
      const dryRun = args.dry_run !== false;
      const delay = Number(args.delay_ms ?? 400);
      if (dryRun) {
        return {
          dry_run: true,
          would_flag_count: ids.length,
          would_flag: ids,
          note: "Set dry_run:false and confirm:true to execute. No undo exists.",
        };
      }
      if (args.confirm !== true)
        throw new Error("dry_run is false but confirm is not true. Refusing to execute.");

      const results: Json[] = [];
      for (const id of ids) {
        try {
          // {ingredient:{id, name, ...}} — unwrap or ingredient_id comes back undefined
          const raw = await recipalFetch(`/recipes/${id}/create_subrecipe`, { method: "POST" });
          const ing = unwrap(raw);
          const ingredientId = pickId(ing, "id", "ingredient_id");
          if (!ingredientId)
            throw new Error(`create_subrecipe returned no ingredient id: ${JSON.stringify(raw)}`);
          results.push({
            recipe_id: id,
            ok: true,
            ingredient_id: ingredientId,
            ingredient_name: ing.name,
            per_100g: {
              calories: ing.calories,
              carbohydrate: ing.carbohydrate,
              sugar: ing.sugar,
              added_sugar: ing.added_sugar,
              fiber: ing.fiber,
              sugar_alcohol: ing.sugar_alcohol,
              protein: ing.protein,
              fat: ing.fat,
            },
          });
        } catch (e) {
          results.push({ recipe_id: id, ok: false, error: String(e) });
        }
        await sleep(delay);
      }
      return {
        executed: true,
        succeeded: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
        results,
      };
    }

    case "bulk_clone_and_swap": {
      const templateId = String(args.template_recipe_id);
      const swapRiId = String(args.swap_recipe_ingredient_id);
      const entries = (args.entries as Array<Json>) ?? [];
      const dryRun = args.dry_run !== false;
      const delay = Number(args.delay_ms ?? 500);

      // Resolve which ingredient_id the template's swap line points at.
      const tmplLines = extractRecords(
        await recipalFetch(`/recipes/${templateId}/recipe_ingredients`)
      );
      const tmplLine = tmplLines.find((l) => pickId(l, "id") === swapRiId);
      if (!tmplLine)
        throw new Error(
          `recipe_ingredient ${swapRiId} not found on template ${templateId}. ` +
            `Lines present: ${tmplLines.map((l) => `${pickId(l, "id")}=${l.name ?? ""}`).join(", ")}`
        );
      const tmplIngredientId = pickId(tmplLine, "ingredient_id");

      if (dryRun) {
        return {
          dry_run: true,
          template_recipe_id: templateId,
          template_lines: tmplLines.map((l) => ({
            recipe_ingredient_id: pickId(l, "id"),
            ingredient_id: pickId(l, "ingredient_id"),
            name: l.name,
            unit: l.unit,
            quantity: l.quantity,
            total_grams: l.total_grams,
          })),
          swap_line_currently_points_at: tmplIngredientId,
          would_create_count: entries.length,
          would_create: entries.map((e) => ({ name: e.name, ingredient_id: e.ingredient_id })),
          note:
            "Verify the template lines above are exactly right before executing. " +
            "Set dry_run:false and confirm:true to run. No undo exists.",
        };
      }
      if (args.confirm !== true)
        throw new Error("dry_run is false but confirm is not true. Refusing to execute.");

      const results: Json[] = [];
      for (const [i, e] of entries.entries()) {
        const step: Json = { index: i, name: e.name, ok: false };
        try {
          // 1. clone the template
          const clone = (await recipalFetch(`/recipes/${templateId}/scale`, {
            method: "POST",
            body: { recipe: { name: e.name, scale_factor: 1, ...((e.fields as Json) ?? {}) } },
          })) as Json;
          // {recipe:{id, ...}} — unwrap before reading the new id
          const newId = pickId(unwrap(clone), "id", "recipe_id");
          step.new_recipe_id = newId;
          if (!newId) throw new Error(`clone returned no id: ${JSON.stringify(clone)}`);

          // 2. ensure the name took (some copy endpoints append "(copy)")
          if (e.name) {
            await recipalFetch(`/recipes/${newId}`, {
              method: "PUT",
              body: { recipe: { name: e.name } },
            });
          }

          // 3. locate the corresponding line on the clone
          const cloneLines = extractRecords(
            await recipalFetch(`/recipes/${newId}/recipe_ingredients`)
          );
          const target =
            cloneLines.find((l) => pickId(l, "ingredient_id") === tmplIngredientId) ??
            cloneLines.find((l) => l.name === tmplLine.name);
          if (!target)
            throw new Error(
              `could not find the line to swap on clone ${newId}; ` +
                `lines: ${JSON.stringify(cloneLines.map((l) => pickId(l, "ingredient_id")))}`
            );
          const targetId = pickId(target, "id");
          step.swapped_recipe_ingredient_id = targetId;

          // 4. DELETE + CREATE, not PUT.
          // PUT /recipe_ingredients/{id} silently DISCARDS ingredient_id — it
          // returns 200 with the old ingredient still attached. Verified against
          // the live API. Swapping must be delete-then-create.
          await recipalFetch(`/recipes/${newId}/recipe_ingredients/${targetId}`, {
            method: "DELETE",
          });
          const created = (await recipalFetch(`/recipes/${newId}/recipe_ingredients`, {
            method: "POST",
            body: {
              recipe_ingredient: {
                ingredient_id: e.ingredient_id,
                ...((e.ingredient_fields as Json) ?? {}),
              },
            },
          })) as Json;
          const createdLine = unwrap(created);
          step.new_recipe_ingredient_id = pickId(createdLine, "id");
          // verify the swap actually took
          const landed = pickId(createdLine, "ingredient_id");
          if (landed && String(landed) !== String(e.ingredient_id))
            throw new Error(
              `swap did not take on ${newId}: asked for ingredient ${e.ingredient_id}, got ${landed}`
            );
          step.total_grams = createdLine.total_grams;
          step.ok = true;
        } catch (err) {
          step.error = String(err);
        }
        results.push(step);
        await sleep(delay);
      }
      return {
        executed: true,
        succeeded: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
        results,
      };
    }

    /* ---- escape hatch ---- */
    case "recipal_request": {
      const method = String(args.method).toUpperCase();
      if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method))
        throw new Error(`Unsupported method: ${method}`);
      if (method !== "GET" && args.confirm !== true)
        throw new Error(`${method} requires confirm:true.`);
      return recipalFetch(String(args.path), {
        method,
        query: args.query as Json,
        body: args.body as Json,
        asJson,
      });
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

const server = new Server(
  { name: "recipal-mcp-unofficial", version: VERSION },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: enabledTools() }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    const result = await handle(name, (args ?? {}) as Json);
    const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    return { content: [{ type: "text", text }] };
  } catch (e) {
    log(`ERROR in ${name}:`, e);
    return {
      content: [{ type: "text", text: `Error calling ${name}:\n${String(e)}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

const hidden = TOOLS.filter((t) => !isEnabled(t.name)).map((t) => t.name);
log(
  `ready — v${VERSION}, ${enabledTools().length}/${TOOLS.length} tools exposed, base ${API_BASE}` +
    (hidden.length ? `; disabled: ${hidden.join(", ")}` : "")
);
