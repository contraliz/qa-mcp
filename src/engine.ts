import { loadConfig, headlessMode } from "./config.js";
import { ElectronStageManager } from "./electron-stage.js";
import { StageManager, type StageBackend } from "./stage.js";

export type EngineName = "playwright" | "electron";

export function engineName(): EngineName {
  const fromEnv = (process.env.QA_ENGINE ?? "").trim().toLowerCase();
  if (fromEnv === "electron" || fromEnv === "playwright") return fromEnv;
  // CI and headless runs cannot show an Electron window; do not pretend otherwise.
  if (headlessMode()) return "playwright";
  return loadConfig().engine ?? "playwright";
}

/**
 * Playwright drives a real browser window parked off-screen. Electron drives a
 * window that is never shown at all, which is the point of the second engine.
 * CI stays on Playwright: it needs no display.
 */
export function createStages(): StageBackend {
  return engineName() === "electron" ? new ElectronStageManager() : new StageManager();
}
