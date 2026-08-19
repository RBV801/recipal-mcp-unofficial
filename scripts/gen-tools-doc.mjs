/**
 * Generates docs/TOOLS.md by asking the built server for its own tool list.
 *
 * Hand-maintained tool documentation in this project drifted badly — earlier docs
 * described three tools that never existed. Generating from the running server
 * means the reference cannot be wrong.
 *
 *   npm run build && npm run gen:docs
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { listTools } from "./mcp-harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "docs", "TOOLS.md");

const GATE_NOTE = {
  delete_recipe: "RECIPAL_MCP_ALLOW_DELETE=1",
  delete_recipe_ingredient: "RECIPAL_MCP_ALLOW_DELETE=1",
  recipal_request: "RECIPAL_MCP_ENABLE_RAW=1",
};

function renderParams(schema) {
  const props = schema?.properties ?? {};
  const required = new Set(schema?.required ?? []);
  const names = Object.keys(props);
  if (!names.length) return "_No parameters._\n";

  const rows = names.map((name) => {
    const p = props[name] ?? {};
    let type = p.type ?? "any";
    if (type === "array") type = `array<${p.items?.type ?? "any"}>`;
    const desc = (p.description ?? "").replace(/\s+/g, " ").replace(/\|/g, "\\|");
    return `| \`${name}\` | ${type} | ${required.has(name) ? "yes" : "no"} | ${desc} |`;
  });

  return ["| Parameter | Type | Required | Notes |", "|---|---|---|---|", ...rows].join("\n") + "\n";
}

// Ask with every gate enabled so the reference documents the full surface.
const all = await listTools({
  RECIPAL_MCP_ALLOW_DELETE: "1",
  RECIPAL_MCP_ENABLE_RAW: "1",
});
const defaultOn = await listTools({});
const defaultNames = new Set(defaultOn.map((t) => t.name));

const lines = [
  "# Tool reference",
  "",
  "<!-- GENERATED FILE — do not edit by hand.",
  "     Regenerate with: npm run build && npm run gen:docs -->",
  "",
  `${all.length} tools total. ${defaultOn.length} are exposed by default; the rest require an`,
  "environment variable to be set by whoever runs the server (see the README).",
  "",
  "| Tool | Exposed by default |",
  "|---|---|",
  ...all.map((t) => {
    const anchor = t.name.replace(/_/g, "");
    const status = defaultNames.has(t.name)
      ? "yes"
      : `no — needs \`${GATE_NOTE[t.name] ?? "a flag"}\``;
    return `| [\`${t.name}\`](#${anchor}) | ${status} |`;
  }),
  "",
];

for (const t of all) {
  lines.push(`## ${t.name}`);
  lines.push("");
  if (!defaultNames.has(t.name)) {
    lines.push(
      `> **Disabled by default.** Set \`${GATE_NOTE[t.name] ?? "the relevant flag"}\` in the server` +
        " environment and restart to expose this tool."
    );
    lines.push("");
  }
  lines.push((t.description ?? "").replace(/\s+/g, " "));
  lines.push("");
  lines.push(renderParams(t.inputSchema));
}

writeFileSync(OUT, lines.join("\n"));
console.log(`wrote ${path.relative(ROOT, OUT)} — ${all.length} tools (${defaultOn.length} default-on)`);
