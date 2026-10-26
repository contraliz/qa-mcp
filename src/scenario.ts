import { join } from "node:path";
import { assertAllowedUrl, defaultViewport, navTimeout, redactUrl } from "./config.js";
import { type ActAction, type MeasurementSet, type StageBackend, type Viewport } from "./stage.js";
import { newId, runDir, savePng, writeJson, ensureDirs } from "./store.js";

export type StepAction =
  | "goto"
  | "click"
  | "fill"
  | "press"
  | "hover"
  | "select"
  | "scroll"
  | "wait_for"
  | "capture";

export interface ScenarioStep {
  action: StepAction;
  selector?: string;
  text?: string;
  value?: string;
  name?: string;
  timeout_ms?: number;
}

export interface ScenarioSpec {
  name: string;
  url: string;
  viewport?: Viewport;
  steps: ScenarioStep[];
}

export interface StepResult {
  index: number;
  action: string;
  ok: boolean;
  target: string;
  ms: number;
  error?: string;
  capture?: string;
}

export interface RunResult {
  run_id: string;
  scenario: string;
  url: string;
  viewport: Viewport;
  steps: StepResult[];
  measurements: MeasurementSet;
  artifacts: { dir: string; captures: string[]; meta: string; steps: string; measurements: string };
  started_at: string;
  finished_at: string;
}

interface RunMeta {
  run_id: string;
  scenario: string;
  url: string;
  viewport: Viewport;
  started_at: string;
  finished_at: string;
  tool: string;
}

/** Executes steps exactly as given. It never adds, retries, or repairs steps. */
export async function runScenario(
  manager: StageBackend,
  spec: ScenarioSpec,
): Promise<RunResult> {
  await ensureDirs();
  if (!spec.steps?.length) throw new Error("scenario has no steps");
  const entryUrl = assertAllowedUrl(spec.url).toString();
  const viewport = spec.viewport ?? defaultViewport();
  const runId = newId("run");
  const startedAt = new Date().toISOString();
  const stage = await manager.open({ url: entryUrl, viewport, hidden: true });
  const results: StepResult[] = [];
  const captures: string[] = [];

  try {
    for (const [index, step] of spec.steps.entries()) {
      const started = Date.now();
      const target = step.selector ?? step.text ?? step.name ?? "";
      try {
        if (step.action === "goto") {
          const target = assertAllowedUrl(step.value ?? entryUrl, entryUrl).toString();
          await manager.goto(stage.stage_id, target, step.timeout_ms ?? navTimeout());
        } else if (step.action === "wait_for") {
          const waited = await manager.waitFor(stage.stage_id, {
            selector: step.selector,
            text: step.text,
            timeout_ms: step.timeout_ms ?? 5000,
          });
          if (!waited.met) throw new Error(`condition not met within ${waited.elapsed_ms}ms`);
        } else if (step.action === "capture") {
          const shot = await manager.capture(stage.stage_id, {});
          const name = step.name ?? `step-${index + 1}`;
          await savePng(runId, name, shot.png);
          captures.push(name);
          results.push({
            index,
            action: step.action,
            ok: true,
            target: name,
            ms: Date.now() - started,
            capture: name,
          });
          continue;
        } else {
          const act: ActAction = {
            type: step.action as ActAction["type"],
            selector: step.selector,
            text: step.text,
            value: step.value,
            timeout_ms: step.timeout_ms,
          };
          const [outcome] = await manager.act(stage.stage_id, [act]);
          if (!outcome?.ok) throw new Error(outcome?.error ?? "action failed");
        }
        results.push({ index, action: step.action, ok: true, target, ms: Date.now() - started });
      } catch (err) {
        results.push({
          index,
          action: step.action,
          ok: false,
          target,
          ms: Date.now() - started,
          error: err instanceof Error ? err.message.slice(0, 300) : String(err),
        });
        break;
      }
    }

    const measurements = await manager.measure(stage.stage_id);
    const finalShot = await manager.capture(stage.stage_id, {});
    await savePng(runId, "final", finalShot.png);
    captures.push("final");

    const finishedAt = new Date().toISOString();
    const meta: RunMeta = {
      run_id: runId,
      scenario: spec.name,
      url: redactUrl(entryUrl),
      viewport,
      started_at: startedAt,
      finished_at: finishedAt,
      tool: "qa-mcp 0.2.0",
    };
    const dir = runDir(runId);
    await writeJson(join(dir, "meta.json"), meta);
    await writeJson(join(dir, "steps.json"), results);
    await writeJson(join(dir, "measurements.json"), measurements);

    return {
      run_id: runId,
      scenario: spec.name,
      url: spec.url,
      viewport,
      steps: results,
      measurements,
      artifacts: {
        dir,
        captures,
        meta: join(dir, "meta.json"),
        steps: join(dir, "steps.json"),
        measurements: join(dir, "measurements.json"),
      },
      started_at: startedAt,
      finished_at: finishedAt,
    };
  } finally {
    await manager.close(stage.stage_id);
  }
}
