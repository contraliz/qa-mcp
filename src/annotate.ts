import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertAllowedUrl, defaultViewport, headlessMode, redactUrl } from "./config.js";
import { ANNOTATION_SCRIPT } from "./inpage-annotation.js";
import type { StageBackend, Viewport } from "./stage.js";
import { dirs, ensureDirs, newId, readJson, writeJson } from "./store.js";

export type AnnotationStatus = "waiting" | "ready" | "resolved" | "abandoned";

export interface AnnotationMark {
  n: number;
  shape: "box";
  rect: { x: number; y: number; w: number; h: number };
  note: string;
  element: {
    selector: string | null;
    tag: string;
    role: string | null;
    name: string;
    box: { x: number; y: number; w: number; h: number };
    resolution: "exact" | "unresolved";
  };
}

export interface Annotation {
  annotation_id: string;
  status: AnnotationStatus;
  created_at: string;
  updated_at: string;
  url: string;
  viewport: Viewport;
  marks: AnnotationMark[];
  crops: string[];
  full: string | null;
  resolution_note: string | null;
  note: string;
}

interface OverlayState {
  status: "drawing" | "sent";
  marks: AnnotationMark[];
}

const POLL_MS = 350;

function file(id: string): string {
  return join(dirs.annotations, id, "annotation.json");
}

function clampClip(
  rect: { x: number; y: number; w: number; h: number },
  viewport: Viewport,
): { x: number; y: number; width: number; height: number } {
  const x = Math.max(0, Math.min(rect.x, viewport.width - 1));
  const y = Math.max(0, Math.min(rect.y, viewport.height - 1));
  const width = Math.max(1, Math.min(rect.w, viewport.width - x));
  const height = Math.max(1, Math.min(rect.h, viewport.height - y));
  return { x, y, width, height };
}

async function saveAnnotation(annotation: Annotation): Promise<void> {
  annotation.updated_at = new Date().toISOString();
  await writeJson(file(annotation.annotation_id), annotation);
}

/**
 * Opens the app in a visible window with a drawing overlay. Returns immediately;
 * the annotation becomes `ready` when the user presses Send.
 *
 * Works identically on both engines: the overlay writes its marks onto
 * `window.__qaAnnotation` and this loop reads them back.
 */
export async function startAnnotation(
  manager: StageBackend,
  options: { url: string; viewport?: Viewport; timeoutMs?: number },
): Promise<Annotation> {
  if (headlessMode()) {
    throw new Error(
      "annotations need a visible window: this server is running headless (QA_HEADLESS or CI). " +
        "Start it on a desktop session to annotate.",
    );
  }
  await ensureDirs();
  const target = assertAllowedUrl(options.url).toString();
  const viewport = options.viewport ?? defaultViewport();
  const id = newId("ann");
  const annotation: Annotation = {
    annotation_id: id,
    status: "waiting",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    url: redactUrl(target),
    viewport,
    marks: [],
    crops: [],
    full: null,
    resolution_note: null,
    note: "waiting for the user to draw and press Send",
  };
  await mkdir(join(dirs.annotations, id), { recursive: true });
  await saveAnnotation(annotation);

  void (async () => {
    let stageId: string | null = null;
    let settled = false;
    try {
      const stage = await manager.open({ url: target, viewport, hidden: false });
      stageId = stage.stage_id;
      await manager.focus(stageId);
      await manager.evaluate(stageId, ANNOTATION_SCRIPT);

      const deadline = Date.now() + (options.timeoutMs ?? 30 * 60_000);
      while (!settled && Date.now() < deadline) {
        const overlay = await manager.evaluate<OverlayState | null>(
          stageId,
          "window.__qaAnnotation && window.__qaAnnotation.status ? window.__qaAnnotation : null",
        );
        if (overlay?.status === "sent" && overlay.marks?.length) {
          const dir = join(dirs.annotations, id);
          const crops: string[] = [];
          for (const mark of overlay.marks) {
            const shot = await manager.capture(stageId, { clip: clampClip(mark.rect, viewport) });
            const name = `crop-${String(mark.n).padStart(2, "0")}.png`;
            await writeFile(join(dir, name), shot.png);
            crops.push(name);
          }
          const full = await manager.capture(stageId, {});
          await writeFile(join(dir, "full.png"), full.png);

          annotation.marks = overlay.marks;
          annotation.crops = crops;
          annotation.full = "full.png";
          annotation.status = "ready";
          annotation.note = `${overlay.marks.length} mark(s) from the user`;
          await saveAnnotation(annotation);
          settled = true;
          break;
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
      }

      if (!settled) {
        annotation.status = "abandoned";
        annotation.note = "annotation window timed out or was closed before Send";
        await saveAnnotation(annotation);
      }
    } catch (err) {
      if (!settled) {
        annotation.status = "abandoned";
        annotation.note = `annotation failed: ${err instanceof Error ? err.message : String(err)}`;
        await saveAnnotation(annotation);
      }
    } finally {
      if (stageId) await manager.close(stageId).catch(() => undefined);
    }
  })();

  return annotation;
}

export async function listAnnotations(status?: string): Promise<Annotation[]> {
  await ensureDirs();
  const entries = await readdir(dirs.annotations).catch(() => [] as string[]);
  const all: Annotation[] = [];
  for (const entry of entries) {
    try {
      const parsed = await readJson<Annotation>(file(entry));
      if (!status || status === "all" || parsed.status === status) all.push(parsed);
    } catch {
      // ignore partially written folders
    }
  }
  return all.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function getAnnotation(id: string): Promise<Annotation> {
  return readJson<Annotation>(file(id));
}

export async function resolveAnnotation(id: string, note: string): Promise<Annotation> {
  const annotation = await getAnnotation(id);
  annotation.status = "resolved";
  annotation.resolution_note = note;
  await saveAnnotation(annotation);
  return annotation;
}
