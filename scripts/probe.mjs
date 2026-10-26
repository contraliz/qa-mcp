#!/usr/bin/env node
/**
 * Smoke test for the stdio transport: starts the server, lists tools, calls one.
 * Run: node scripts/probe.mjs
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const child = spawn(process.execPath, [join(root, "dist", "server.js")], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, QA_HOME: join(root, "qa") },
});

const pending = new Map();
let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});

child.stderr.on("data", (chunk) => process.stderr.write(chunk));

function call(id, method, params) {
  const promise = new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => reject(new Error(`${method} timed out`)), 15000);
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return promise;
}

const init = await call(1, "initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "probe", version: "0" },
});
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

const tools = await call(2, "tools/list", {});
const annotations = await call(3, "tools/call", {
  name: "annotations_list",
  arguments: { status: "all" },
});

console.log("server:", init.result.serverInfo);
console.log("tools:", tools.result.tools.map((t) => t.name).join(", "));
console.log("annotations_list:", annotations.result.content[0].text.slice(0, 200));

child.stdin.end();
child.kill();
