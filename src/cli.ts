#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { allowedHosts, assertAllowedUrl, configPath, loadConfig, qaHome, scenariosDir } from "./config.js";
import { runScenario } from "./scenario.js";
import { createStages, engineName } from "./engine.js";
import { baselineFile, collectGarbage, listBaselines, promoteBaseline, readJson, runDir } from "./store.js";

const VERSION = "0.4.1";

async function promote(args: string[]): Promise<void> {
  const [runId, name] = args;
  if (!runId || !name) throw new Error("usage: qa-mcp baseline promote <run_id> <capture_name>");
  const meta = await readJson<{ scenario: string }>(join(runDir(runId), "meta.json"));
  const target = await promoteBaseline(runId, name, meta.scenario);
  console.log(JSON.stringify({ promoted: target, scenario: meta.scenario, capture: name }, null, 2));
}

async function list(args: string[]): Promise<void> {
  const [scenario] = args;
  if (!scenario) throw new Error("usage: qa-mcp baseline list <scenario>");
  const names = await listBaselines(scenario);
  console.log(JSON.stringify({ scenario, baselines: names.map((n) => baselineFile(scenario, n)) }, null, 2));
}

async function initCommand(args: string[]): Promise<void> {
  const urlArg = args.includes("--url") ? args[args.indexOf("--url") + 1] : undefined;
  const engineArg = args.includes("--engine") ? args[args.indexOf("--engine") + 1] : undefined;
  if (engineArg && engineArg !== "playwright" && engineArg !== "electron") {
    throw new Error("--engine must be playwright or electron");
  }
  const baseUrl = urlArg ?? "http://127.0.0.1:5173/";
  const url = new URL(baseUrl);
  const hostPort = url.port ? `${url.hostname}:${url.port}` : url.hostname;
  const dir = resolve(".qa");
  const configFile = join(dir, "config.json");
  const scenarioFile = join(dir, "scenarios", "smoke.json");
  await mkdir(join(dir, "scenarios"), { recursive: true });

  const written: string[] = [];
  const skipped: string[] = [];

  if (existsSync(configFile)) {
    skipped.push(configFile);
  } else {
    await writeFile(
      configFile,
      JSON.stringify(
        {
          baseUrl,
          engine: engineArg ?? "playwright",
          allowHosts: [hostPort, "localhost", "127.0.0.1"],
          scenariosDir: ".qa/scenarios",
          viewport: { width: 1280, height: 800 },
        },
        null,
        2,
      ) + "\n",
    );
    written.push(configFile);
  }

  if (existsSync(scenarioFile)) {
    skipped.push(scenarioFile);
  } else {
    await writeFile(
      scenarioFile,
      JSON.stringify(
        {
          name: "smoke",
          url: baseUrl,
          viewport: { width: 1280, height: 800 },
          steps: [
            { action: "goto", value: "/" },
            { action: "capture", name: "home" },
          ],
        },
        null,
        2,
      ) + "\n",
    );
    written.push(scenarioFile);
  }

  console.log(
    JSON.stringify(
      {
        written,
        skipped,
        next: [
          `1. start your app at ${baseUrl}`,
          "2. qa-mcp run smoke",
          "3. qa-mcp baseline promote <run_id> home   (after a human looks at the frame)",
          "4. register the MCP server with your agent harness: qa-mcp serve on stdio",
        ],
        mcp: {
          qa: {
            type: "local",
            command: ["npx", "qa-mcp", "serve"],
            environment: { QA_HOME: resolve("qa") },
          },
        },
      },
      null,
      2,
    ),
  );
}

async function doctor(): Promise<void> {
  const checks: Array<{ check: string; ok: boolean; detail: string }> = [];
  const add = (check: string, ok: boolean, detail: string) => checks.push({ check, ok, detail });

  const major = Number(process.versions.node.split(".")[0]);
  add("node", major >= 20, `v${process.versions.node} (need >= 20)`);

  let cfg = {};
  try {
    cfg = loadConfig();
    add("config", true, `${configPath()} ${Object.keys(cfg).length ? "loaded" : "absent (defaults)"}`);
  } catch (err) {
    add("config", false, err instanceof Error ? err.message : String(err));
  }

  const home = qaHome();
  try {
    await mkdir(home, { recursive: true });
    const probe = join(home, ".doctor-probe");
    await writeFile(probe, "ok");
    await unlink(probe);
    add("artifacts", true, home);
  } catch (err) {
    add("artifacts", false, `${home}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const engine = engineName();
  if (engine === "playwright") {
    try {
      const pw = await import("playwright");
      const exe = pw.chromium.executablePath();
      add("playwright", existsSync(exe), `${pw.chromium.name()} at ${exe}`);
    } catch (err) {
      add("playwright", false, err instanceof Error ? err.message : String(err));
    }
  } else {
    try {
      const require = createRequire(import.meta.url);
      const exe = require("electron") as string;
      add("electron", existsSync(exe), exe);
    } catch {
      add("electron", false, "not installed: npm i -D electron");
    }
  }

  const hosts = allowedHosts();
  add("allow-hosts", true, hosts === "*" ? "* (open)" : hosts.join(", "));

  const baseUrl = (cfg as { baseUrl?: string }).baseUrl;
  if (baseUrl) {
    try {
      assertAllowedUrl(baseUrl);
      add("base-url", true, baseUrl);
    } catch (err) {
      add("base-url", false, err instanceof Error ? err.message : String(err));
    }
  } else {
    add("base-url", true, "not set (pass a url per run)");
  }

  const ok = checks.every((c) => c.ok);
  console.log(JSON.stringify({ ok, engine, checks }, null, 2));
  if (!ok) process.exitCode = 1;
}

async function runFile(args: string[]): Promise<void> {
  let file = args[0];
  if (!file) throw new Error("usage: qa-mcp run <scenario.json|name>");
  if (!existsSync(file) && !file.endsWith(".json")) {
    const candidate = join(scenariosDir(), `${file}.json`);
    if (existsSync(candidate)) file = candidate;
  }
  const spec = JSON.parse(await readFile(file, "utf8"));
  const manager = createStages();
  try {
    const result = await runScenario(manager, spec);
    console.log(
      JSON.stringify(
        {
          run_id: result.run_id,
          scenario: result.scenario,
          ok: result.steps.every((s) => s.ok),
          steps: result.steps,
          measurements: result.measurements.measurements.map((m) => ({ rule: m.rule, count: m.count })),
          runtime_events: result.measurements.runtime.length,
          artifacts: result.artifacts,
        },
        null,
        2,
      ),
    );
    // Non-zero only when a step could not execute. Judging the measurements is
    // the caller's job, not this process's.
    if (result.steps.some((s) => !s.ok)) process.exitCode = 2;
  } finally {
    await manager.closeAll();
  }
}

async function gc(args: string[]): Promise<void> {
  const keepArg = args.includes("--keep") ? args[args.indexOf("--keep") + 1] : args[0];
  const keep = Number(keepArg ?? 20);
  if (!Number.isInteger(keep) || keep < 0) throw new Error("usage: qa-mcp gc [--keep 20]");
  console.log(JSON.stringify(await collectGarbage(keep), null, 2));
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "serve") {
    await import("./server.js");
    return;
  }
  if (command === "--version" || command === "-v") {
    console.log(`qa-mcp ${VERSION}`);
    return;
  }
  if (command === "init") return initCommand(rest);
  if (command === "doctor") return doctor();
  if (command === "run") return runFile(rest);
  if (command === "gc") return gc(rest);
  if (command === "baseline") {
    const [action, ...args] = rest;
    if (action === "promote") return promote(args);
    if (action === "list") return list(args);
    throw new Error("usage: qa-mcp baseline <promote|list> ...");
  }
  console.error(`unknown command: ${command}`);
  console.error(
    "commands: serve, init [--url ...] [--engine ...], doctor, run <scenario|name>, gc [--keep 20], baseline promote <run_id> <name>, baseline list <scenario>",
  );
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
