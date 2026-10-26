/**
 * Runtime configuration.
 *
 * Precedence is always: environment variable > `.qa/config.json` > default.
 * Config is read per call so a long-lived MCP process and a CLI invocation see
 * the same file without a restart.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface QaConfig {
  baseUrl?: string;
  engine?: "playwright" | "electron";
  allowHosts?: string[] | "*";
  headless?: boolean;
  viewport?: { width: number; height: number };
  scenariosDir?: string;
  qaHome?: string;
  navTimeoutMs?: number;
  actionTimeoutMs?: number;
}

export class ConfigError extends Error {
  constructor(path: string, detail: string) {
    super(`invalid qa config at ${path}: ${detail}`);
    this.name = "ConfigError";
  }
}

export function configPath(cwd = process.cwd()): string {
  return process.env.QA_CONFIG
    ? resolve(process.env.QA_CONFIG)
    : join(cwd, ".qa", "config.json");
}

/** Throws on a broken config: a silent fallback would hide the mistake. */
export function loadConfig(cwd = process.cwd()): QaConfig {
  const path = configPath(cwd);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(path, err instanceof Error ? err.message : String(err));
  }
  if (!parsed || typeof parsed !== "object") throw new ConfigError(path, "expected an object");
  const cfg = parsed as QaConfig;
  if (cfg.engine && cfg.engine !== "playwright" && cfg.engine !== "electron") {
    throw new ConfigError(path, `engine must be "playwright" or "electron", got ${JSON.stringify(cfg.engine)}`);
  }
  if (cfg.allowHosts !== undefined && cfg.allowHosts !== "*" && !Array.isArray(cfg.allowHosts)) {
    throw new ConfigError(path, 'allowHosts must be an array or "*"');
  }
  return cfg;
}

function flag(name: string): boolean | null {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  if (raw === "") return null;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return null;
}

export function headlessMode(): boolean {
  const explicit = flag("QA_HEADLESS");
  if (explicit !== null) return explicit;
  const configured = loadConfig().headless;
  if (typeof configured === "boolean") return configured;
  return flag("CI") === true;
}

export function numberFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function navTimeout(): number {
  return numberFromEnv("QA_NAV_TIMEOUT_MS", loadConfig().navTimeoutMs ?? 30_000);
}

export function actionTimeout(): number {
  return numberFromEnv("QA_ACTION_TIMEOUT_MS", loadConfig().actionTimeoutMs ?? 5_000);
}

export function qaHome(cwd = process.cwd()): string {
  const fromEnv = process.env.QA_HOME;
  if (fromEnv) return resolve(fromEnv);
  const configured = loadConfig(cwd).qaHome;
  return resolve(cwd, configured ?? "qa");
}

export function scenariosDir(cwd = process.cwd()): string {
  return resolve(cwd, loadConfig(cwd).scenariosDir ?? join(".qa", "scenarios"));
}

export function defaultViewport(): { width: number; height: number } {
  return loadConfig().viewport ?? { width: 1280, height: 800 };
}

const DEFAULT_HOSTS = ["localhost", "127.0.0.1", "::1", "[::1]"];

export function allowedHosts(): string[] | "*" {
  const raw = (process.env.QA_ALLOW_HOSTS ?? "").trim();
  if (raw === "*") return "*";
  if (raw) {
    return raw
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
  }
  const configured = loadConfig().allowHosts;
  if (configured === "*") return "*";
  if (Array.isArray(configured) && configured.length) {
    return configured.map((h) => String(h).toLowerCase());
  }
  return DEFAULT_HOSTS;
}

function hostMatches(entry: string, url: URL): boolean {
  const hostname = url.hostname.toLowerCase();
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  const [entryHost, entryPort] = entry.split(":");
  if (entryPort) {
    if (entryPort !== port) return false;
  }
  if (entryHost.startsWith("*.")) {
    return hostname.endsWith(entryHost.slice(1)) && hostname !== entryHost.slice(2);
  }
  return hostname === entryHost;
}

export class UrlNotAllowed extends Error {
  constructor(url: string, hosts: string[] | "*") {
    super(
      `url not allowed by QA_ALLOW_HOSTS or .qa/config.json allowHosts: ${url} (allowed: ${
        hosts === "*" ? "*" : hosts.join(", ")
      })`,
    );
    this.name = "UrlNotAllowed";
  }
}

/** Validates scheme and host. Throws UrlNotAllowed with a remediation hint. */
export function assertAllowedUrl(raw: string, base?: string): URL {
  let url: URL;
  try {
    url = base ? new URL(raw, base) : new URL(raw);
  } catch {
    throw new Error(`not a valid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`only http and https are supported, got ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error("URLs with embedded credentials are refused; pass credentials as form input");
  }
  const hosts = allowedHosts();
  if (hosts === "*") return url;
  if (!hosts.some((entry) => hostMatches(entry, url))) {
    throw new UrlNotAllowed(url.toString(), hosts);
  }
  return url;
}

const SECRET_PARAM = /(token|key|secret|password|passwd|auth|session|sig|code|credential)/i;

/**
 * Strips credentials and secret-looking query values before a URL is stored in
 * a run artifact. Console text is left verbatim; see the safety section in README.
 */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    const params = url.searchParams;
    for (const key of [...params.keys()]) {
      if (SECRET_PARAM.test(key)) params.set(key, "[redacted]");
    }
    return url.toString();
  } catch {
    return raw.replace(/\/\/[^/@\s]+@/, "//");
  }
}
