#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { assertAllowedUrl } from "./config.js";
import { diffAgainstBaseline } from "./diff.js";
import {
  getAnnotation,
  listAnnotations,
  resolveAnnotation,
  startAnnotation,
} from "./annotate.js";
import { runScenario, type ScenarioStep } from "./scenario.js";
import { createStages } from "./engine.js";
import type { ActAction } from "./stage.js";
import { dirs, readJson, runDir, saveFindings, type Finding } from "./store.js";
import { join } from "node:path";

const VERSION = "0.4.1";
const manager = createStages();

function text(value: unknown): { type: "text"; text: string } {
  return { type: "text", text: JSON.stringify(value, null, 2) };
}

function image(png: Buffer): { type: "image"; data: string; mimeType: string } {
  return { type: "image", data: png.toString("base64"), mimeType: "image/png" };
}

function fail(message: string) {
  return { content: [{ type: "text" as const, text: `error: ${message}` }], isError: true };
}

const server = new McpServer({ name: "qa-mcp", version: VERSION });

server.registerTool(
  "stage_open",
  {
    title: "Open a stage",
    description:
      "Open a URL in a real browser window owned by this server. The window is parked off-screen unless hidden=false. Returns a stage_id. Does not choose what to test.",
    inputSchema: {
      url: z.string().describe("absolute URL to open"),
      width: z.number().int().min(200).max(3840).optional().describe("viewport width, default 1280"),
      height: z.number().int().min(200).max(2160).optional().describe("viewport height, default 800"),
      hidden: z.boolean().optional().describe("park the window off-screen, default true"),
    },
  },
  async ({ url, width, height, hidden }) => {
    try {
      const state = await manager.open({
        url: assertAllowedUrl(url).toString(),
        viewport: width && height ? { width, height } : undefined,
        hidden: hidden ?? true,
      });
      return { content: [text(state)] };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
);

server.registerTool(
  "stage_close",
  {
    title: "Close a stage",
    description: "Close a stage and its browser context.",
    inputSchema: { stage_id: z.string() },
  },
  async ({ stage_id }) => {
    await manager.close(stage_id);
    return { content: [text({ stage_id, closed: true })] };
  },
);

server.registerTool(
  "stage_focus",
  {
    title: "Bring a stage on screen",
    description: "Move a stage window from off-screen to the visible desktop and focus it.",
    inputSchema: { stage_id: z.string() },
  },
  async ({ stage_id }) => {
    try {
      return { content: [text(await manager.focus(stage_id))] };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
);

server.registerTool(
  "stage_state",
  {
    title: "Stage state",
    description:
      "Report URL, viewport, hidden flag, last capture time, capture staleness, and runtime error counts for a stage.",
    inputSchema: { stage_id: z.string() },
  },
  async ({ stage_id }) => {
    try {
      return { content: [text(await manager.state(stage_id))] };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
);

server.registerTool(
  "act",
  {
    title: "Perform actions",
    description:
      "Execute the given click/fill/press/hover/select/scroll actions in order. No extra steps, no retries, no healing. Returns per-action ok/error/timing.",
    inputSchema: {
      stage_id: z.string(),
      actions: z.array(
        z.object({
          type: z.enum(["click", "fill", "press", "hover", "select", "scroll"]),
          selector: z.string().optional().describe("CSS selector"),
          text: z.string().optional().describe("visible text to locate instead of selector"),
          value: z.string().optional().describe("text to type, key to press, option to select, or scroll pixels"),
          timeout_ms: z.number().int().positive().optional(),
        }),
      ),
    },
  },
  async ({ stage_id, actions }) => {
    try {
      return { content: [text(await manager.act(stage_id, actions as ActAction[]))] };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
);

server.registerTool(
  "capture",
  {
    title: "Capture the stage",
    description:
      "Take a PNG of the current stage and return it as an image block plus metadata. Reports when it was taken; it does not judge the frame.",
    inputSchema: {
      stage_id: z.string(),
      full_page: z.boolean().optional(),
      clip: z
        .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
        .optional(),
    },
  },
  async ({ stage_id, full_page, clip }) => {
    try {
      const shot = await manager.capture(stage_id, { full_page, clip });
      return { content: [text(shot.meta), image(shot.png)] };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
);

server.registerTool(
  "wait_for",
  {
    title: "Wait for an explicit condition",
    description:
      "Wait until a selector is visible or a text appears, up to timeout_ms. There is no implicit 'ready' heuristic.",
    inputSchema: {
      stage_id: z.string(),
      selector: z.string().optional(),
      text: z.string().optional(),
      timeout_ms: z.number().int().positive().optional(),
    },
  },
  async ({ stage_id, selector, text: needle, timeout_ms }) => {
    try {
      return { content: [text(await manager.waitFor(stage_id, { selector, text: needle, timeout_ms }))] };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
);

server.registerTool(
  "measure",
  {
    title: "Measure the rendered page",
    description:
      "Run rule-based measurements on the live page: horizontal overflow, broken images, missing alt, small tap targets, clipped text, plus collected console/page/network errors. Every rule returns its definition and threshold.",
    inputSchema: { stage_id: z.string() },
  },
  async ({ stage_id }) => {
    try {
      return { content: [text(await manager.measure(stage_id))] };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
);

server.registerTool(
  "scenario_run",
  {
    title: "Run a named scenario",
    description:
      "Open a URL, execute the supplied steps exactly as written, capture the requested frames, and store a run under qa/runs/<run_id>. Steps are never invented, repaired, or retried.",
    inputSchema: {
      name: z.string().describe("scenario name, used to key baselines"),
      url: z.string(),
      width: z.number().int().optional(),
      height: z.number().int().optional(),
      steps: z.array(
        z.object({
          action: z.enum([
            "goto",
            "click",
            "fill",
            "press",
            "hover",
            "select",
            "scroll",
            "wait_for",
            "capture",
          ]),
          selector: z.string().optional(),
          text: z.string().optional(),
          value: z.string().optional(),
          name: z.string().optional().describe("capture name, used by diff and baselines"),
          timeout_ms: z.number().int().positive().optional(),
        }),
      ),
    },
  },
  async ({ name, url, width, height, steps }) => {
    try {
      const result = await runScenario(manager, {
        name,
        url,
        viewport: width && height ? { width, height } : undefined,
        steps: steps as ScenarioStep[],
      });
      return { content: [text(result)] };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
);

server.registerTool(
  "diff",
  {
    title: "Diff a capture against its baseline",
    description:
      "Compare a named capture from a run with the promoted baseline for that scenario. Returns changed pixel counts and a bounding box, and writes a diff image. Does not decide if the change is acceptable.",
    inputSchema: { run_id: z.string(), name: z.string() },
  },
  async ({ run_id, name }) => {
    try {
      const meta = await readJson<{ scenario: string }>(join(runDir(run_id), "meta.json"));
      return {
        content: [text(await diffAgainstBaseline({ runId: run_id, name, scenario: meta.scenario }))],
      };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
);

server.registerTool(
  "findings_store",
  {
    title: "Store findings",
    description:
      "Persist findings supplied by the caller. Each finding needs a claim and at least one evidence reference. This stores; it does not grade, dedupe, or resolve.",
    inputSchema: {
      run_id: z.string(),
      verdict: z.string().optional().describe("the caller's verdict text, stored verbatim"),
      findings: z.array(
        z.object({
          step: z.string().optional(),
          selector: z.string().optional(),
          claim: z.string(),
          evidence: z.array(z.string()).min(1),
        }),
      ),
    },
  },
  async ({ run_id, verdict, findings }) => {
    try {
      return { content: [text(await saveFindings(run_id, findings as Finding[], verdict))] };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
);

server.registerTool(
  "annotate_start",
  {
    title: "Start an annotation session",
    description:
      "Open a visible window with a drawing overlay so the user can mark parts of the app and attach notes. Returns immediately; poll annotations_list until status is ready.",
    inputSchema: {
      url: z.string(),
      width: z.number().int().optional(),
      height: z.number().int().optional(),
    },
  },
  async ({ url, width, height }) => {
    try {
      const annotation = await startAnnotation(manager, {
        url: assertAllowedUrl(url).toString(),
        viewport: width && height ? { width, height } : undefined,
      });
      return {
        content: [
          text({
            annotation_id: annotation.annotation_id,
            status: annotation.status,
            note: "the user annotates in the visible window; check annotations_list for status ready",
          }),
        ],
      };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
);

server.registerTool(
  "annotations_list",
  {
    title: "List annotations",
    description: "List annotation sessions and their status. Marks and notes are returned verbatim.",
    inputSchema: { status: z.enum(["waiting", "ready", "resolved", "abandoned", "all"]).optional() },
  },
  async ({ status }) => {
    try {
      const all = await listAnnotations(status ?? "all");
      return {
        content: [
          text(
            all.map((a) => ({
              annotation_id: a.annotation_id,
              status: a.status,
              created_at: a.created_at,
              url: a.url,
              marks: a.marks.length,
              notes: a.marks.map((m) => m.note),
            })),
          ),
        ],
      };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
);

server.registerTool(
  "annotations_get",
  {
    title: "Get one annotation",
    description:
      "Return an annotation bundle with each mark's element, rect, note, and the cropped images of the marked regions.",
    inputSchema: { annotation_id: z.string() },
  },
  async ({ annotation_id }) => {
    try {
      const annotation = await getAnnotation(annotation_id);
      const dir = join(dirs.annotations, annotation_id);
      const content: Array<ReturnType<typeof text> | ReturnType<typeof image>> = [text(annotation)];
      const fs = await import("node:fs/promises");
      for (const crop of annotation.crops) {
        const png = await fs.readFile(join(dir, crop));
        content.push(image(png));
      }
      return { content };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
);

server.registerTool(
  "annotations_resolve",
  {
    title: "Resolve an annotation",
    description: "Mark an annotation as handled and record how it was addressed.",
    inputSchema: { annotation_id: z.string(), note: z.string() },
  },
  async ({ annotation_id, note }) => {
    try {
      return { content: [text(await resolveAnnotation(annotation_id, note))] };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`qa-mcp ${VERSION} ready on stdio`);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void manager.closeAll().finally(() => process.exit(0));
  });
}

main().catch(async (err) => {
  console.error("qa-mcp failed to start:", err);
  await manager.closeAll().catch(() => undefined);
  process.exit(1);
});
