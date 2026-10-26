import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { baselineFile, runDir } from "./store.js";

export interface DiffResult {
  run_id: string;
  name: string;
  baseline: string;
  capture: string;
  size_match: boolean;
  changed_pixels: number | null;
  total_pixels: number | null;
  changed_ratio: number | null;
  bbox: { x: number; y: number; w: number; h: number } | null;
  diff_path: string | null;
  note: string;
}

function readPng(path: string): Promise<PNG> {
  return readFile(path).then((buf) => PNG.sync.read(buf));
}

/**
 * Compares a capture against a promoted baseline. Reports the measurement only;
 * whether the change is acceptable is not decided here.
 */
export async function diffAgainstBaseline(options: {
  runId: string;
  name: string;
  scenario: string;
}): Promise<DiffResult> {
  const capturePath = join(runDir(options.runId), "captures", `${options.name}.png`);
  const basePath = baselineFile(options.scenario, options.name);

  const [capture, baseline] = await Promise.all([
    readPng(capturePath).catch(() => null),
    readPng(basePath).catch(() => null),
  ]);

  if (!capture) throw new Error(`no capture named ${JSON.stringify(options.name)} in ${options.runId}`);
  if (!baseline) {
    return {
      run_id: options.runId,
      name: options.name,
      baseline: basePath,
      capture: capturePath,
      size_match: false,
      changed_pixels: null,
      total_pixels: null,
      changed_ratio: null,
      bbox: null,
      diff_path: null,
      note: "no baseline exists for this capture; promote one with the CLI after a human review",
    };
  }

  if (baseline.width !== capture.width || baseline.height !== capture.height) {
    return {
      run_id: options.runId,
      name: options.name,
      baseline: basePath,
      capture: capturePath,
      size_match: false,
      changed_pixels: null,
      total_pixels: baseline.width * baseline.height,
      changed_ratio: null,
      bbox: null,
      diff_path: null,
      note: `size mismatch: baseline ${baseline.width}x${baseline.height}, capture ${capture.width}x${capture.height}`,
    };
  }

  const diff = new PNG({ width: capture.width, height: capture.height });
  const changed = pixelmatch(baseline.data, capture.data, diff.data, capture.width, capture.height, {
    threshold: 0.1,
    includeAA: false,
  });

  let minX = capture.width;
  let minY = capture.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < capture.height; y++) {
    for (let x = 0; x < capture.width; x++) {
      const idx = (capture.width * y + x) * 4;
      if (diff.data[idx + 3] !== 0) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  const out = join(runDir(options.runId), "diffs", `${options.name}-vs-baseline.png`);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, PNG.sync.write(diff));

  return {
    run_id: options.runId,
    name: options.name,
    baseline: basePath,
    capture: capturePath,
    size_match: true,
    changed_pixels: changed,
    total_pixels: capture.width * capture.height,
    changed_ratio: Number((changed / (capture.width * capture.height)).toFixed(6)),
    bbox: maxX >= 0 ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null,
    diff_path: out,
    note: "pixel match at threshold 0.1, antialiasing excluded",
  };
}
