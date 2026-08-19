/**
 * Offline smoke tests. These never touch the ReciPal API — they boot the built
 * server over real stdio and check the protocol surface and the safety gates.
 *
 *   npm run build && npm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { listTools, callTool, serverExit, withServer } from "../scripts/mcp-harness.mjs";

const GATED = ["delete_recipe", "delete_recipe_ingredient", "recipal_request"];
const ALL_GATES = { RECIPAL_MCP_ALLOW_DELETE: "1", RECIPAL_MCP_ENABLE_RAW: "1" };

test("server completes the MCP handshake and reports its name and version", async () => {
  await withServer({}, async ({ init }) => {
    assert.equal(init.serverInfo.name, "recipal-mcp-unofficial");
    assert.match(init.serverInfo.version, /^\d+\.\d+\.\d+$/);
  });
});

test("with all gates enabled, the full tool surface is advertised", async () => {
  const tools = await listTools(ALL_GATES);
  assert.equal(tools.length, 22, `expected 22 tools, got ${tools.length}`);
  for (const name of GATED) {
    assert.ok(
      tools.some((t) => t.name === name),
      `${name} should be present when its gate is enabled`
    );
  }
});

test("by default, destructive and raw tools are hidden", async () => {
  const tools = await listTools({});
  const names = tools.map((t) => t.name);
  for (const name of GATED) {
    assert.ok(!names.includes(name), `${name} must not be advertised by default`);
  }
  assert.equal(tools.length, 19, `expected 19 default tools, got ${tools.length}`);
});

test("every tool has a description and a valid object input schema", async () => {
  const tools = await listTools(ALL_GATES);
  for (const t of tools) {
    assert.ok(t.description && t.description.length > 20, `${t.name} needs a real description`);
    assert.equal(t.inputSchema.type, "object", `${t.name} inputSchema must be an object`);
    for (const req of t.inputSchema.required ?? []) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(t.inputSchema.properties ?? {}, req),
        `${t.name} marks "${req}" required but does not define it`
      );
    }
  }
});

test("calling a gated tool without its flag fails and names the env var", async () => {
  const res = await callTool("delete_recipe", { recipe_id: "1", confirm: true }, {});
  assert.equal(res.isError, true, "expected an error result");
  assert.match(res.content[0].text, /RECIPAL_MCP_ALLOW_DELETE=1/);
});

test("raw request tool is refused without its flag", async () => {
  const res = await callTool("recipal_request", { method: "GET", path: "/recipes" }, {});
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /RECIPAL_MCP_ENABLE_RAW=1/);
});

test("a mutating raw request still requires confirm even when the flag is on", async () => {
  const res = await callTool(
    "recipal_request",
    { method: "DELETE", path: "/recipes/1" },
    { RECIPAL_MCP_ENABLE_RAW: "1" }
  );
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /requires confirm:true/);
});

test("bulk tools default to a dry run that touches nothing", async () => {
  const res = await callTool("bulk_create_subrecipes", { recipe_ids: ["1", "2"] }, {});
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.dry_run, true);
  assert.equal(body.would_flag_count, 2);
});

test("unknown tool names are rejected", async () => {
  const res = await callTool("definitely_not_a_tool", {}, {});
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Unknown tool/);
});

test("missing API key is a fatal startup error, not a silent no-op", async () => {
  const { code, stderr } = await serverExit({ RECIPAL_API_KEY: "" });
  assert.equal(code, 1);
  assert.match(stderr, /RECIPAL_API_KEY is not set/);
});

test("a non-recipal.com API base is refused so the key cannot be exfiltrated", async () => {
  const { code, stderr } = await serverExit({
    RECIPAL_API_KEY: "x",
    RECIPAL_API_BASE: "https://example.com/api/v1",
  });
  assert.equal(code, 1);
  assert.match(stderr, /not a recipal\.com host/);
});

test("a non-https API base is refused", async () => {
  const { code, stderr } = await serverExit({
    RECIPAL_API_KEY: "x",
    RECIPAL_API_BASE: "http://www.recipal.com/api/v1",
  });
  assert.equal(code, 1);
  assert.match(stderr, /must use https/);
});

test("an explicitly allowed custom base is accepted", async () => {
  await withServer(
    { RECIPAL_API_BASE: "https://example.com/api/v1", RECIPAL_MCP_ALLOW_CUSTOM_BASE: "1" },
    async ({ call }) => {
      const { tools } = await call("tools/list", {});
      assert.ok(tools.length > 0);
    }
  );
});
