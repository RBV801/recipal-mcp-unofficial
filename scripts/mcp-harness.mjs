/**
 * Minimal stdio JSON-RPC client for talking to the built server.
 * Shared by scripts/gen-tools-doc.mjs and the smoke tests, so both exercise the
 * real server over the real transport rather than importing internals.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(ROOT, "build", "index.js");

/**
 * Start the server, run `fn(call)` against it, then shut it down.
 * `env` is merged over a minimal base. No network calls are made by
 * initialize/tools/list, so a placeholder API key is fine.
 */
export async function withServer(env, fn) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, RECIPAL_API_KEY: "placeholder-not-used", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += d.toString();
  });

  const pending = new Map();
  let buf = "";
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        // stdout must be pure JSON-RPC; anything else is a protocol violation.
        for (const { reject } of pending.values()) {
          reject(new Error(`non-JSON on stdout (protocol corruption): ${line.slice(0, 200)}`));
        }
        pending.clear();
        continue;
      }
      const entry = pending.get(msg.id);
      if (entry) {
        pending.delete(msg.id);
        msg.error ? entry.reject(new Error(JSON.stringify(msg.error))) : entry.resolve(msg.result);
      }
    }
  });

  let nextId = 1;
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`timeout waiting for ${method}\nstderr:\n${stderr}`));
        }
      }, 15_000);
    });

  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));

  try {
    // Race initialize against an early exit so a config failure reports clearly.
    const init = call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "recipal-mcp-unofficial-harness", version: "1.0.0" },
    });
    const raced = await Promise.race([
      init,
      exited.then((code) => {
        throw new Error(`server exited with code ${code} during initialize\nstderr:\n${stderr}`);
      }),
    ]);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    return await fn({ call, init: raced, stderr: () => stderr });
  } finally {
    child.kill();
  }
}

/** Start the server and return only its exit code and stderr. */
export async function serverExit(env) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += d.toString();
  });
  const code = await new Promise((resolve) => child.on("exit", resolve));
  return { code, stderr };
}

export const listTools = (env = {}) =>
  withServer(env, async ({ call }) => (await call("tools/list", {})).tools);

export const callTool = (name, args, env = {}) =>
  withServer(env, async ({ call }) => call("tools/call", { name, arguments: args }));
