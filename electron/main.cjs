/**
 * Electron helper: owns the stage windows and nothing else.
 *
 * Starts hidden, off the taskbar, and never takes focus unless asked. The Node
 * MCP server drives it over loopback HTTP with a per-process token. This file
 * contains no product logic: it opens windows, injects input, captures, and
 * evaluates the script it is handed.
 */
const { app, BrowserWindow, session } = require("electron");
const http = require("node:http");
const crypto = require("node:crypto");

const TOKEN = process.env.QA_ENGINE_TOKEN || crypto.randomBytes(16).toString("hex");
const stages = new Map();
let lastRequest = Date.now();

app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
app.commandLine.appendSwitch("hide-scrollbars");

function log(...args) {
  process.stderr.write(`[qa-electron] ${args.join(" ")}\n`);
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function push(stage, event) {
  stage.events.push({ at: new Date().toISOString(), ...event });
  if (stage.events.length > 300) stage.events.splice(0, stage.events.length - 300);
}

function stageOf(id) {
  const stage = stages.get(id);
  if (!stage) throw new Error(`unknown stage: ${id}`);
  return stage;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 8 * 1024 * 1024) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(new Error(`invalid JSON body: ${err.message}`));
      }
    });
    req.on("error", reject);
  });
}

async function cdp(stage, method, params) {
  const dbg = stage.win.webContents.debugger;
  if (!dbg.isAttached()) dbg.attach("1.3");
  return dbg.sendCommand(method, params);
}

function wireEvents(stage) {
  const wc = stage.win.webContents;
  const id = wc.id;

  wc.on("console-message", (...args) => {
    // Electron has shipped two signatures; accept both.
    const level = typeof args[1] === "number" ? args[1] : args[0]?.level;
    const message = typeof args[1] === "number" ? args[2] : args[0]?.message;
    if (level !== 3 && level !== "error") return;
    push(stage, { kind: "console_error", text: String(message ?? "").slice(0, 500) });
  });

  wc.on("did-fail-load", (_e, code, description, url) => {
    if (code === -3) return; // aborted navigation, not a failure
    push(stage, { kind: "request_failed", text: `${description} (${code})`, url: String(url).slice(0, 300) });
  });

  wc.on("render-process-gone", (_e, details) => {
    push(stage, { kind: "page_error", text: `renderer gone: ${details.reason}` });
  });

  const filter = { urls: ["*://*/*"] };
  session.defaultSession.webRequest.onCompleted(filter, (details) => {
    if (details.webContentsId !== id) return;
    if (details.statusCode < 400) return;
    push(stage, {
      kind: "http_error",
      status: details.statusCode,
      text: "",
      url: String(details.url).slice(0, 300),
    });
  });
  session.defaultSession.webRequest.onErrorOccurred(filter, (details) => {
    if (details.webContentsId !== id) return;
    push(stage, { kind: "request_failed", text: details.error, url: String(details.url).slice(0, 300) });
  });

  wc.on("did-finish-load", () => {
    stage.lastLoadAt = Date.now();
  });
}

function toState(stage) {
  const wc = stage.win.webContents;
  const count = (kind) => stage.events.filter((e) => e.kind === kind).length;
  return {
    stage_id: stage.id,
    url: wc.getURL(),
    viewport: stage.viewport,
    hidden: stage.hidden,
    created_at: stage.createdAt,
    last_capture_at: stage.lastCaptureAt ? new Date(stage.lastCaptureAt).toISOString() : null,
    capture_stale: !stage.lastCaptureAt || Date.now() - stage.lastCaptureAt > 15000,
    console_errors: count("console_error"),
    page_errors: count("page_error"),
    failed_requests: count("request_failed") + count("http_error"),
  };
}

async function openStage(options) {
  const width = options.width || 1280;
  const height = options.height || 800;
  const hidden = options.hidden !== false;

  const win = new BrowserWindow({
    width,
    height,
    frame: false,
    x: -20000,
    y: -20000,
    show: false,
    skipTaskbar: hidden,
    focusable: !hidden,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      offscreen: false,
    },
  });
  win.webContents.setBackgroundThrottling(false);
  try {
    win.setMenuBarVisibility(false);
  } catch {
    // frameless windows have no menu bar
  }

  const stage = {
    id: `stg-${crypto.randomUUID().slice(0, 8)}`,
    win,
    hidden,
    viewport: { width, height },
    createdAt: new Date().toISOString(),
    lastCaptureAt: null,
    events: [],
  };
  stages.set(stage.id, stage);
  wireEvents(stage);

  win.on("closed", () => {
    stages.delete(stage.id);
  });

  await win.loadURL(options.url);
  win.setContentSize(width, height);
  if (hidden) {
    // A window that is never shown has no compositor surface on Windows, so
    // captures fail. Park it far off-screen and keep it out of the taskbar:
    // it paints normally and never appears in front of the user.
    win.setPosition(-20000, -20000);
    win.showInactive();
  } else {
    win.show();
  }
  // Make sure at least one frame exists before the first capture.
  await win.webContents
    .executeJavaScript("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))")
    .catch(() => undefined);
  // Report the real content box: Windows may adjust the requested size.
  const [realWidth, realHeight] = win.getContentSize();
  stage.viewport = { width: realWidth, height: realHeight };
  return toState(stage);
}

function injectInput(stage, payload) {
  const wc = stage.win.webContents;
  switch (payload.type) {
    case "click": {
      const { x, y } = payload;
      wc.sendInputEvent({ type: "mouseMove", x, y });
      wc.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
      wc.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
      return { ok: true };
    }
    case "move": {
      wc.sendInputEvent({ type: "mouseMove", x: payload.x, y: payload.y });
      return { ok: true };
    }
    case "wheel": {
      wc.sendInputEvent({
        type: "mouseWheel",
        x: payload.x ?? 0,
        y: payload.y ?? 0,
        deltaX: 0,
        deltaY: payload.deltaY ?? 400,
        canScroll: true,
      });
      return { ok: true };
    }
    case "text": {
      wc.insertText(String(payload.text ?? ""));
      return { ok: true };
    }
    case "key": {
      wc.sendInputEvent({ type: "keyDown", keyCode: payload.key });
      wc.sendInputEvent({ type: "keyUp", keyCode: payload.key });
      return { ok: true };
    }
    default:
      throw new Error(`unsupported input type: ${payload.type}`);
  }
}

async function route(req, res) {
  lastRequest = Date.now();
  if (req.headers["x-qa-token"] !== TOKEN) return send(res, 403, { error: "forbidden" });
  const url = new URL(req.url, "http://127.0.0.1");
  const path = url.pathname;

  if (path === "/health") return send(res, 200, { ok: true, stages: stages.size });
  if (req.method !== "POST") return send(res, 405, { error: "use POST" });

  const body = await readBody(req);

  switch (path) {
    case "/open":
      return send(res, 200, await openStage(body));
    case "/close": {
      const stage = stageOf(body.stage_id);
      stage.win.destroy();
      return send(res, 200, { closed: true });
    }
    case "/focus": {
      const stage = stageOf(body.stage_id);
      stage.hidden = false;
      stage.win.setPosition(80, 60);
      stage.win.setSkipTaskbar(false);
      stage.win.setFocusable(true);
      stage.win.show();
      stage.win.focus();
      return send(res, 200, toState(stage));
    }
    case "/state": {
      const stage = stageOf(body.stage_id);
      return send(res, 200, toState(stage));
    }
    case "/goto": {
      const stage = stageOf(body.stage_id);
      await stage.win.loadURL(body.url);
      return send(res, 200, { url: stage.win.webContents.getURL() });
    }
    case "/evaluate": {
      const stage = stageOf(body.stage_id);
      const value = await stage.win.webContents.executeJavaScript(body.script, true);
      return send(res, 200, { value: value === undefined ? null : value });
    }
    case "/input": {
      const stage = stageOf(body.stage_id);
      return send(res, 200, injectInput(stage, body));
    }
    case "/capture": {
      const stage = stageOf(body.stage_id);
      let png;
      if (body.full_page) {
        const shot = await cdp(stage, "Page.captureScreenshot", {
          format: "png",
          fromSurface: true,
          captureBeyondViewport: true,
        });
        png = shot.data;
      } else {
        const image = await stage.win.webContents.capturePage(
          body.clip
            ? { x: body.clip.x, y: body.clip.y, width: body.clip.width, height: body.clip.height }
            : undefined,
        );
        png = image.toPNG().toString("base64");
      }
      stage.lastCaptureAt = Date.now();
      return send(res, 200, {
        png,
        meta: {
          stage_id: stage.id,
          url: stage.win.webContents.getURL(),
          viewport: stage.viewport,
          full_page: Boolean(body.full_page),
          clip: body.clip ?? null,
          captured_at: new Date(stage.lastCaptureAt).toISOString(),
        },
      });
    }
    case "/events": {
      const stage = stageOf(body.stage_id);
      return send(res, 200, { events: stage.events });
    }
    default:
      return send(res, 404, { error: `no route: ${path}` });
  }
}

app.whenReady().then(() => {
  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      log("request failed:", err.message);
      send(res, 500, { error: err.message });
    });
  });
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    // The only thing written to stdout: the handshake line.
    process.stdout.write(JSON.stringify({ qa_electron: true, port, token: TOKEN }) + "\n");
    log(`listening on 127.0.0.1:${port}`);
    // If the parent died without killing us, do not linger forever.
    setInterval(() => {
      if (stages.size === 0 && Date.now() - lastRequest > 15 * 60 * 1000) app.quit();
    }, 60_000).unref();
  });
});

app.on("window-all-closed", () => {
  // Keep the helper alive: the next stage may open at any time.
});

process.on("SIGTERM", () => app.quit());
process.on("SIGINT", () => app.quit());
