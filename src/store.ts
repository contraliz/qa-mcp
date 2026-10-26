import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  writeFile,
  copyFile,
  rm,
  access,
  open,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { qaHome } from "./config.js";

/** Root for all run artifacts: QA_HOME > .qa/config.json qaHome > ./qa */
export const ROOT = qaHome();

export const dirs = {
  runs: join(ROOT, "runs"),
  baselines: join(ROOT, "baselines"),
  annotations: join(ROOT, "annotations"),
  findings: join(ROOT, "findings"),
};

export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
}

export async function ensureDirs(): Promise<void> {
  await Promise.all(Object.values(dirs).map((d) => mkdir(d, { recursive: true })));
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function runDir(runId: string): string {
  return join(dirs.runs, runId);
}

export async function savePng(runId: string, name: string, data: Buffer): Promise<string> {
  const file = join(runDir(runId), "captures", `${name}.png`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, data);
  return file;
}

export function baselineFile(scenario: string, name: string): string {
  return join(dirs.baselines, slug(scenario), `${slug(name)}.png`);
}

export async function promoteBaseline(
  runId: string,
  name: string,
  scenario: string,
): Promise<string> {
  const from = join(runDir(runId), "captures", `${slug(name)}.png`);
  if (!(await exists(from))) {
    throw new Error(`no capture named ${JSON.stringify(name)} in ${runId}`);
  }
  const to = baselineFile(scenario, name);
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to);
  return to;
}

export async function listBaselines(scenario: string): Promise<string[]> {
  try {
    const entries = await readdir(join(dirs.baselines, slug(scenario)));
    return entries.filter((e) => e.endsWith(".png")).map((e) => e.slice(0, -4));
  } catch {
    return [];
  }
}

export async function removeRun(runId: string): Promise<void> {
  await rm(runDir(runId), { recursive: true, force: true });
}

export interface Finding {
  step?: string;
  selector?: string;
  claim: string;
  evidence: string[];
}

/**
 * Serialises read-modify-write on a single file across processes. Two agents
 * sharing one QA_HOME must not lose each other's findings.
 */
async function withLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  for (;;) {
    let handle;
    try {
      handle = await open(lockPath, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs > 10_000) {
          await unlink(lockPath).catch(() => undefined);
          continue;
        }
      } catch {
        // the holder removed it between open and stat
      }
      if (Date.now() - started > 10_000) {
        throw new Error(`timed out waiting for lock: ${lockPath}`);
      }
      await new Promise((r) => setTimeout(r, 25));
      continue;
    }
    try {
      return await fn();
    } finally {
      await handle.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    }
  }
}

export async function saveFindings(
  runId: string,
  findings: Finding[],
  verdict?: string,
): Promise<{ ids: string[]; file: string }> {
  if (!(await exists(runDir(runId)))) {
    throw new Error(`unknown run: ${runId}`);
  }
  for (const [i, f] of findings.entries()) {
    if (!f.claim?.trim()) throw new Error(`finding ${i} has no claim`);
    if (!Array.isArray(f.evidence) || f.evidence.length === 0) {
      throw new Error(`finding ${i} has no evidence reference`);
    }
  }
  const file = join(dirs.findings, `${runId}.json`);
  await mkdir(dirs.findings, { recursive: true });
  return withLock(`${file}.lock`, async () => {
    const existing = (await exists(file))
      ? await readJson<{ findings: unknown[] }>(file)
      : { findings: [] };
    const stamped = findings.map((f) => ({
      id: newId("fnd"),
      recorded_at: new Date().toISOString(),
      ...f,
    }));
    await writeJson(file, {
      run_id: runId,
      verdict: verdict ?? null,
      findings: [...existing.findings, ...stamped],
    });
    return { ids: stamped.map((f) => f.id), file };
  });
}

/** Deletes the oldest runs so an unattended CI workspace cannot fill the disk. */
export async function collectGarbage(
  keep: number,
): Promise<{ removed: string[]; kept: number }> {
  await ensureDirs();
  const entries = await readdir(dirs.runs, { withFileTypes: true }).catch(() => []);
  const runs = await Promise.all(
    entries
      .filter((e) => e.isDirectory())
      .map(async (e) => ({
        name: e.name,
        mtime: (await stat(join(dirs.runs, e.name))).mtimeMs,
      })),
  );
  runs.sort((a, b) => b.mtime - a.mtime);
  const doomed = runs.slice(Math.max(0, keep));
  const removed: string[] = [];
  for (const run of doomed) {
    await rm(join(dirs.runs, run.name), { recursive: true, force: true });
    await rm(join(dirs.findings, `${run.name}.json`), { force: true });
    removed.push(run.name);
  }
  return { removed, kept: runs.length - removed.length };
}

export function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}
