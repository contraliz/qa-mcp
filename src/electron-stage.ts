import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { actionTimeout, defaultViewport, headlessMode } from "./config.js";
import { MEASURE_SCRIPT } from "./inpage.js";
import type {
  ActAction,
  ActResult,
  CaptureOptions,
  MeasurementSet,
  RuntimeEvent,
  StageBackend,
  StageState,
  Viewport,
  WaitCondition,
} from "./stage.js";

interface Handshake {
  qa_electron: boolean;
  port: number;
  token: string;
}

const require = createRequire(import.meta.url);

function electronBinary(): string {
  try {
    return require("electron") as string;
  } catch {
    throw new Error(
      "the electron engine needs the electron package: npm i -D electron (or set QA_ENGINE=playwright)",
    );
  }
}

const VISIBLE_SCRIPT = (selector: string) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const s = getComputedStyle(el);
  const visible = r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  return { visible, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
})()`;

const TEXT_SCRIPT = (text: string) => `document.body ? document.body.innerText.includes(${JSON.stringify(text)}) : false`;

/**
 * Drives real Electron windows. Hidden by default: show:false, skipped from the
 * taskbar, not focusable. The page still paints and accepts synthetic input.
 */
export class ElectronStageManager implements StageBackend {
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private handshake: Handshake | null = null;
  private starting: Promise<Handshake> | null = null;
  private stderr: string[] = [];

  private async start(): Promise<Handshake> {
    if (this.handshake) return this.handshake;
    if (this.starting) return this.starting;
    if (headlessMode()) {
      throw new Error(
        "the electron engine needs a desktop session; use QA_ENGINE=playwright under CI",
      );
    }

    const binary = electronBinary();
    const main = fileURLToPath(new URL("../electron/main.cjs", import.meta.url));
    const token = randomBytes(16).toString("hex");

    this.starting = new Promise<Handshake>((resolve, reject) => {
      const child = spawn(binary, [main], {
        env: { ...process.env, QA_ENGINE_TOKEN: token, ELECTRON_ENABLE_LOGGING: "0" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.child = child;

      const timer = setTimeout(() => {
        reject(new Error(`electron helper did not start in 30s\n${this.stderr.join("\n")}`));
      }, 30_000);

      let buffer = "";
      child.stdout.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        let index;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (!line) continue;
          try {
            const parsed = JSON.parse(line) as Handshake;
            if (parsed.qa_electron) {
              clearTimeout(timer);
              this.handshake = parsed;
              resolve(parsed);
            }
          } catch {
            // ignore non-handshake output
          }
        }
      });

      child.stderr.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        this.stderr.push(text);
        if (this.stderr.length > 50) this.stderr.shift();
      });

      child.on("exit", (code) => {
        clearTimeout(timer);
        this.child = null;
        this.handshake = null;
        this.starting = null;
        reject(new Error(`electron helper exited (${code})\n${this.stderr.join("\n").slice(-2000)}`));
      });
    });

    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async call<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const conn = await this.start();
    const timer = setTimeout(() => controller.abort(), actionTimeout() * 4);
    const controller = new AbortController();
    try {
      const res = await fetch(`http://127.0.0.1:${conn.port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-qa-token": conn.token },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const json = (await res.json()) as Record<string, unknown>;
      if (!res.ok) throw new Error(String(json.error ?? `helper returned ${res.status}`));
      return json as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async open(options: { url: string; viewport?: Viewport; hidden?: boolean }): Promise<StageState> {
    const viewport = options.viewport ?? defaultViewport();
    return this.call<StageState>("/open", {
      url: options.url,
      width: viewport.width,
      height: viewport.height,
      hidden: options.hidden ?? true,
    });
  }

  async close(id: string): Promise<void> {
    if (!this.handshake) return;
    await this.call("/close", { stage_id: id }).catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    this.handshake = null;
    this.child?.kill();
    this.child = null;
  }

  async focus(id: string): Promise<StageState> {
    return this.call<StageState>("/focus", { stage_id: id });
  }

  async state(id: string): Promise<StageState> {
    return this.call<StageState>("/state", { stage_id: id });
  }

  async goto(id: string, url: string, timeoutMs?: number): Promise<void> {
    const guard = new AbortController();
    const timer = setTimeout(() => guard.abort(), timeoutMs ?? 30_000);
    try {
      await this.call("/goto", { stage_id: id, url });
    } finally {
      clearTimeout(timer);
    }
  }

  async evaluate<T = unknown>(id: string, script: string): Promise<T> {
    const result = await this.call<{ value: T }>("/evaluate", { stage_id: id, script });
    return result.value;
  }

  async act(id: string, actions: ActAction[]): Promise<ActResult[]> {
    const results: ActResult[] = [];
    for (const [index, action] of actions.entries()) {
      const started = Date.now();
      const target = action.selector ?? action.text ?? "";
      try {
        if (action.type === "scroll") {
          await this.call("/input", {
            stage_id: id,
            type: "wheel",
            deltaY: Number(action.value ?? 400),
            x: 0,
            y: 0,
          });
        } else if (action.type === "fill") {
          const point = await this.point(id, action);
          await this.call("/input", { stage_id: id, type: "click", x: point.x, y: point.y });
          await this.evaluate(
            id,
            `(() => { const el = document.querySelector(${JSON.stringify(action.selector ?? "")}); if (!el) return null; el.focus(); el.select && el.select(); return true; })()`,
          );
          await this.call("/input", { stage_id: id, type: "text", text: String(action.value ?? "") });
        } else if (action.type === "press") {
          await this.call("/input", { stage_id: id, type: "key", key: String(action.value ?? "Enter") });
        } else {
          const point = await this.point(id, action);
          await this.call("/input", {
            stage_id: id,
            type: action.type === "hover" ? "move" : "click",
            x: point.x,
            y: point.y,
          });
        }
        results.push({ index, type: action.type, ok: true, target, ms: Date.now() - started });
      } catch (err) {
        results.push({
          index,
          type: action.type,
          ok: false,
          target,
          ms: Date.now() - started,
          error: err instanceof Error ? err.message.slice(0, 300) : String(err),
        });
      }
    }
    return results;
  }

  private async point(
    id: string,
    action: { selector?: string; text?: string },
  ): Promise<{ x: number; y: number }> {
    if (action.selector) {
      const found = await this.evaluate<{ visible: boolean; x: number; y: number } | null>(
        id,
        VISIBLE_SCRIPT(action.selector),
      );
      if (!found) throw new Error(`selector not found: ${action.selector}`);
      if (!found.visible) throw new Error(`selector not visible: ${action.selector}`);
      return { x: found.x, y: found.y };
    }
    const text = action.text ?? "";
    const found = await this.evaluate<{ x: number; y: number } | null>(
      id,
      `(() => {
        const walk = (root) => {
          for (const el of root.querySelectorAll("*")) {
            if (el.children.length === 0 && (el.textContent || "").includes(${JSON.stringify(text)})) return el;
            const nested = walk(el);
            if (nested) return nested;
          }
          return null;
        };
        const el = walk(document.body);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`,
    );
    if (!found) throw new Error(`text not found: ${text}`);
    return found;
  }

  async waitFor(
    id: string,
    condition: WaitCondition,
  ): Promise<{ met: boolean; elapsed_ms: number }> {
    const started = Date.now();
    const timeout = condition.timeout_ms ?? actionTimeout();
    while (Date.now() - started < timeout) {
      const met = condition.selector
        ? await this.evaluate<{ visible: boolean } | null>(id, VISIBLE_SCRIPT(condition.selector)).then(
            (r) => r?.visible === true,
          )
        : await this.evaluate<boolean>(id, TEXT_SCRIPT(condition.text ?? ""));
      if (met) return { met: true, elapsed_ms: Date.now() - started };
      await new Promise((r) => setTimeout(r, 120));
    }
    return { met: false, elapsed_ms: Date.now() - started };
  }

  async capture(
    id: string,
    options: CaptureOptions = {},
  ): Promise<{ png: Buffer; meta: Record<string, unknown> }> {
    const shot = await this.call<{ png: string; meta: Record<string, unknown> }>("/capture", {
      stage_id: id,
      full_page: options.full_page ?? false,
      clip: options.clip ?? null,
    });
    return { png: Buffer.from(shot.png, "base64"), meta: shot.meta };
  }

  async measure(id: string): Promise<MeasurementSet> {
    const facts = await this.evaluate<Omit<MeasurementSet, "runtime">>(id, MEASURE_SCRIPT);
    const { events } = await this.call<{ events: RuntimeEvent[] }>("/events", { stage_id: id });
    return { ...facts, runtime: events };
  }
}
