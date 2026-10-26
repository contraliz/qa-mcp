import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { actionTimeout, defaultViewport, headlessMode, navTimeout, redactUrl } from "./config.js";
import { MEASURE_SCRIPT } from "./inpage.js";
import { newId } from "./store.js";

export interface Viewport {
  width: number;
  height: number;
}

export interface RuntimeEvent {
  at: string;
  kind: string;
  text: string;
  url?: string;
  status?: number;
}

export interface StageState {
  stage_id: string;
  url: string;
  viewport: Viewport;
  hidden: boolean;
  created_at: string;
  last_capture_at: string | null;
  capture_stale: boolean;
  console_errors: number;
  page_errors: number;
  failed_requests: number;
}

export type ActType = "click" | "fill" | "press" | "hover" | "select" | "scroll";

export interface ActAction {
  type: ActType;
  selector?: string;
  text?: string;
  value?: string;
  timeout_ms?: number;
}

export interface ActResult {
  index: number;
  type: string;
  ok: boolean;
  target: string;
  ms: number;
  error?: string;
}

export interface Measurement {
  rule: string;
  definition: string;
  threshold: string;
  count: number;
  truncated: boolean;
  items: Array<Record<string, unknown>>;
}

export interface MeasurementSet {
  url: string;
  title: string;
  viewport: { w: number; h: number; dpr: number };
  document: { scroll_width: number; scroll_height: number };
  measurements: Measurement[];
  measured_at: string;
  runtime: RuntimeEvent[];
}

export interface CaptureOptions {
  full_page?: boolean;
  clip?: { x: number; y: number; width: number; height: number };
}

export interface WaitCondition {
  selector?: string;
  text?: string;
  timeout_ms?: number;
}

/** The surface every stage backend must provide. */
export interface StageBackend {
  open(options: { url: string; viewport?: Viewport; hidden?: boolean }): Promise<StageState>;
  close(id: string): Promise<void>;
  closeAll(): Promise<void>;
  focus(id: string): Promise<StageState>;
  state(id: string): Promise<StageState>;
  act(id: string, actions: ActAction[]): Promise<ActResult[]>;
  waitFor(id: string, condition: WaitCondition): Promise<{ met: boolean; elapsed_ms: number }>;
  capture(id: string, options?: CaptureOptions): Promise<{ png: Buffer; meta: Record<string, unknown> }>;
  measure(id: string): Promise<MeasurementSet>;
  goto(id: string, url: string, timeoutMs?: number): Promise<void>;
  evaluate<T = unknown>(id: string, script: string): Promise<T>;
}

interface Stage {
  id: string;
  context: BrowserContext;
  page: Page;
  hidden: boolean;
  viewport: Viewport;
  createdAt: string;
  lastCaptureAt: number | null;
  events: RuntimeEvent[];
}

const MAX_EVENTS = 300;
const STALE_MS = 15_000;

function now(): string {
  return new Date().toISOString();
}

function push(stage: Stage, event: RuntimeEvent): void {
  stage.events.push(event);
  if (stage.events.length > MAX_EVENTS) stage.events.splice(0, stage.events.length - MAX_EVENTS);
}

export class StageManager implements StageBackend {
  private browserInstance: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private stages = new Map<string, Stage>();

  private async browser(): Promise<Browser> {
    if (this.browserInstance?.isConnected()) return this.browserInstance;
    if (!this.launching) {
      const channel = process.env.QA_CHANNEL;
      const headless = headlessMode();
      this.launching = chromium.launch({
        headless,
        channel: channel || undefined,
        args: headless
          ? ["--hide-scrollbars", "--force-device-scale-factor=1", "--no-first-run", "--no-default-browser-check"]
          : [
              "--disable-background-timer-throttling",
              "--disable-renderer-backgrounding",
              "--disable-backgrounding-occluded-windows",
              "--disable-features=CalculateNativeWinOcclusion",
              "--hide-scrollbars",
              "--force-device-scale-factor=1",
              "--no-first-run",
              "--no-default-browser-check",
            ],
      });
    }
    try {
      this.browserInstance = await this.launching;
      return this.browserInstance;
    } finally {
      this.launching = null;
    }
  }

  private async park(page: Page, hidden: boolean, viewport: Viewport): Promise<void> {
    if (headlessMode()) return;
    try {
      const cdp = await page.context().newCDPSession(page);
      const { windowId } = (await cdp.send("Browser.getWindowForTarget")) as { windowId: number };
      const bounds = hidden
        ? { left: -20000, top: -20000, width: viewport.width, height: viewport.height, windowState: "normal" as const }
        : { left: 80, top: 60, width: viewport.width, height: viewport.height, windowState: "normal" as const };
      await cdp.send("Browser.setWindowBounds", { windowId, bounds });
      await cdp.detach();
    } catch {
      // Positioning is best-effort; capture and measurement do not depend on it.
    }
  }

  async open(options: {
    url: string;
    viewport?: Viewport;
    hidden?: boolean;
  }): Promise<StageState> {
    const viewport = options.viewport ?? defaultViewport();
    const hidden = options.hidden ?? true;
    const browser = await this.browser();
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: 1,
      reducedMotion: "reduce",
      colorScheme: "light",
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();
    const stage: Stage = {
      id: newId("stg"),
      context,
      page,
      hidden,
      viewport,
      createdAt: now(),
      lastCaptureAt: null,
      events: [],
    };

    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      push(stage, {
        at: now(),
        kind: "console_error",
        text: msg.text().slice(0, 500),
        url: msg.location().url ? redactUrl(msg.location().url) : undefined,
      });
    });
    page.on("pageerror", (err) => {
      push(stage, { at: now(), kind: "page_error", text: String(err.message).slice(0, 500) });
    });
    page.on("requestfailed", (req) => {
      push(stage, {
        at: now(),
        kind: "request_failed",
        text: req.failure()?.errorText ?? "failed",
        url: redactUrl(req.url()).slice(0, 300),
      });
    });
    page.on("response", (res) => {
      if (res.status() >= 400) {
        push(stage, {
          at: now(),
          kind: "http_error",
          status: res.status(),
          text: res.statusText(),
          url: redactUrl(res.url()).slice(0, 300),
        });
      }
    });

    await this.park(page, hidden, viewport);
    await page.goto(options.url, { waitUntil: "load", timeout: navTimeout() });
    this.stages.set(stage.id, stage);
    return this.state(stage.id);
  }

  private get(id: string): Stage {
    const stage = this.stages.get(id);
    if (!stage) throw new Error(`unknown stage: ${id}`);
    return stage;
  }

  state(id: string): Promise<StageState> {
    const stage = this.get(id);
    const count = (kind: string) => stage.events.filter((e) => e.kind === kind).length;
    return Promise.resolve({
      stage_id: stage.id,
      url: stage.page.url(),
      viewport: stage.viewport,
      hidden: stage.hidden,
      created_at: stage.createdAt,
      last_capture_at: stage.lastCaptureAt ? new Date(stage.lastCaptureAt).toISOString() : null,
      capture_stale: stage.lastCaptureAt === null || Date.now() - stage.lastCaptureAt > STALE_MS,
      console_errors: count("console_error"),
      page_errors: count("page_error"),
      failed_requests: count("request_failed") + count("http_error"),
    });
  }

  async focus(id: string): Promise<StageState> {
    const stage = this.get(id);
    await stage.page.bringToFront();
    await this.park(stage.page, false, stage.viewport);
    stage.hidden = false;
    return this.state(id);
  }

  async close(id: string): Promise<void> {
    const stage = this.stages.get(id);
    if (!stage) return;
    this.stages.delete(id);
    await stage.context.close().catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    for (const id of [...this.stages.keys()]) await this.close(id);
    await this.browserInstance?.close().catch(() => undefined);
    this.browserInstance = null;
  }

  page(id: string): Page {
    return this.get(id).page;
  }

  async act(id: string, actions: ActAction[]): Promise<ActResult[]> {
    const stage = this.get(id);
    const results: ActResult[] = [];
    for (const [index, action] of actions.entries()) {
      const started = Date.now();
      const target = action.selector ?? action.text ?? "";
      try {
        if (action.type === "scroll") {
          const page = stage.page;
          if (action.selector) {
            await page.locator(action.selector).first().scrollIntoViewIfNeeded({ timeout: action.timeout_ms ?? actionTimeout() });
          } else {
            await page.mouse.wheel(0, Number(action.value ?? 500));
          }
        } else {
          const locator = action.selector
            ? stage.page.locator(action.selector).first()
            : stage.page.getByText(action.text ?? "", { exact: false }).first();
          const timeout = action.timeout_ms ?? actionTimeout();
          switch (action.type) {
            case "click":
              await locator.click({ timeout });
              break;
            case "fill":
              await locator.fill(String(action.value ?? ""), { timeout });
              break;
            case "press":
              await locator.press(String(action.value ?? "Enter"), { timeout });
              break;
            case "hover":
              await locator.hover({ timeout });
              break;
            case "select":
              await locator.selectOption(String(action.value ?? ""), { timeout });
              break;
            default:
              throw new Error(`unsupported action type: ${String(action.type)}`);
          }
        }
        results.push({ index, type: action.type, ok: true, target, ms: Date.now() - started });
      } catch (err) {
        results.push({
          index,
          type: action.type,
          ok: false,
          target,
          ms: Date.now() - started,
          error: err instanceof Error ? err.message.split("\n")[0].slice(0, 300) : String(err),
        });
      }
    }
    return results;
  }

  async waitFor(
    id: string,
    condition: WaitCondition,
  ): Promise<{ met: boolean; elapsed_ms: number }> {
    const stage = this.get(id);
    const started = Date.now();
    const timeout = condition.timeout_ms ?? actionTimeout();
    try {
      if (condition.selector) {
        await stage.page.locator(condition.selector).first().waitFor({ state: "visible", timeout });
      } else if (condition.text) {
        await stage.page.getByText(condition.text, { exact: false }).first().waitFor({ state: "visible", timeout });
      } else {
        throw new Error("wait_for needs selector or text");
      }
      return { met: true, elapsed_ms: Date.now() - started };
    } catch {
      return { met: false, elapsed_ms: Date.now() - started };
    }
  }

  async capture(
    id: string,
    options: CaptureOptions = {},
  ): Promise<{ png: Buffer; meta: Record<string, unknown> }> {
    const stage = this.get(id);
    const png = await stage.page.screenshot({
      type: "png",
      fullPage: options.full_page ?? false,
      clip: options.clip,
      animations: "disabled",
      caret: "hide",
    });
    stage.lastCaptureAt = Date.now();
    return {
      png,
      meta: {
        stage_id: id,
        url: stage.page.url(),
        viewport: stage.viewport,
        full_page: options.full_page ?? false,
        clip: options.clip ?? null,
        captured_at: new Date(stage.lastCaptureAt).toISOString(),
        bytes: png.length,
      },
    };
  }

  async measure(id: string): Promise<MeasurementSet> {
    const stage = this.get(id);
    const facts = (await stage.page.evaluate(MEASURE_SCRIPT)) as Omit<MeasurementSet, "runtime">;
    return { ...facts, runtime: [...stage.events] };
  }

  async goto(id: string, url: string, timeoutMs?: number): Promise<void> {
    const stage = this.get(id);
    await stage.page.goto(url, { waitUntil: "load", timeout: timeoutMs ?? navTimeout() });
  }

  async evaluate<T = unknown>(id: string, script: string): Promise<T> {
    const stage = this.get(id);
    return (await stage.page.evaluate(script)) as T;
  }
}
