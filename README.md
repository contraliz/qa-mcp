# qa-mcp

A local MCP server that lets an agent **see a running app instead of reading its source**.

It opens the app in a real browser, does exactly what it is told, takes pictures, and reports
measurements. It makes no decisions: no model calls, no severity scores, no self-healing, no
"is this fixed" logic. The calling agent does the judging.

## What it gives an agent

| Tool | Returns | Never does |
| --- | --- | --- |
| `stage_open` | `stage_id`, URL, viewport | choose a URL or size |
| `stage_close`, `stage_focus`, `stage_state` | window lifecycle and state | decide what to look at |
| `act` | per-action ok/error/timing | add steps, retry, heal selectors |
| `capture` | a PNG plus timestamp | judge the frame |
| `wait_for` | whether an explicit condition was met | guess a "ready" heuristic |
| `measure` | rule results with definitions and thresholds | rank or triage them |
| `scenario_run` | run id, per-step facts, artifact paths | invent or repair steps |
| `diff` | changed pixels, bounding box, diff image | call a change good or bad |
| `findings_store` | stored ids; rejects findings with no evidence | grade or dedupe findings |
| `annotate_start` | annotation id, opened overlay | interpret the user's words |
| `annotations_list`, `annotations_get`, `annotations_resolve` | marks, elements, crops, status | paraphrase or fix the note |

Rules measured: horizontal overflow, broken images, missing `alt` text, tap targets under
24×24, clipped text, plus console errors, page errors and failed requests. Every rule reports its
own definition and threshold.

Baseline promotion is deliberately **not** a tool; accepting a new "correct" look is a human
decision and stays in the CLI.

## Requirements

- Node.js 20 or newer
- Chromium for Playwright: `npx playwright install --with-deps chromium`
- Optional: `electron` for the invisible local window engine

## Install

```bash
npm install qa-mcp
npx playwright install --with-deps chromium
```

Or from source:

```bash
git clone https://github.com/contraliz/qa-mcp.git
cd qa-mcp
npm install
npm run build
```

## Quick start

```bash
npx qa-mcp init --url http://localhost:5173/   # writes .qa/config.json + .qa/scenarios/smoke.json
npx qa-mcp doctor                              # node, config, browser, allow-list, artifacts
npx qa-mcp run smoke                           # executes the scenario, writes artifacts
```

`run` exits `0` when every step executed, `2` when a step could not (missing selector, timeout).
Measurement counts are printed, not judged, so your gate stays your gate.

## Register the MCP server

OpenCode (`opencode.json`):

```jsonc
{
  "mcp": {
    "qa": {
      "type": "local",
      "command": ["npx", "qa-mcp", "serve"],
      "environment": { "QA_HOME": "./qa" }
    }
  }
}
```

Claude Code (`.mcp.json`):

```jsonc
{
  "mcpServers": {
    "qa": {
      "command": "npx",
      "args": ["qa-mcp", "serve"],
      "env": { "QA_HOME": "./qa" }
    }
  }
}
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.qa]
command = "npx"
args = ["qa-mcp", "serve"]
env = { QA_HOME = "./qa" }
```

Any stdio MCP client works the same way. Without an MCP client, the CLI covers everything
except live captures and `findings_store`.

## Scenarios

```jsonc
// .qa/scenarios/checkout.json
{
  "name": "checkout",
  "url": "http://localhost:5173/",
  "steps": [
    { "action": "goto", "value": "/" },
    { "action": "fill", "selector": "#email", "value": "sam@example.com" },
    { "action": "click", "selector": "#place-order" },
    { "action": "wait_for", "selector": "#status" },
    { "action": "capture", "name": "after-order" }
  ]
}
```

Steps are literal: `goto`, `click`, `fill`, `press`, `hover`, `select`, `scroll`, `wait_for`,
`capture`. Capture names are what `baseline promote` and `diff` use.

## Engines

| `engine` | Window | Use it for |
| --- | --- | --- |
| `playwright` (default) | Chromium parked far off-screen | CI, servers, and local runs with no extra setup |
| `electron` | Frameless Electron window, never shown until asked | local work: it exists, paints, stays out of the taskbar, and takes no focus |

Under `CI=true` or `QA_HEADLESS=1` the server always uses Playwright headless; Electron needs a
desktop session. The Electron helper starts on demand, binds loopback with a per-process token,
and exits after 15 idle minutes.

## Configuration

`.qa/config.json` (commit it) with environment variables taking precedence:

```jsonc
{
  "baseUrl": "http://localhost:5173/",
  "engine": "electron",
  "allowHosts": ["localhost:5173", "127.0.0.1:5173"],
  "scenariosDir": ".qa/scenarios",
  "viewport": { "width": 1280, "height": 800 }
}
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `QA_HOME` | `./qa` | artifacts root |
| `QA_ENGINE` | `playwright` | `playwright` or `electron` |
| `QA_HEADLESS` | auto on `CI=true` | headed vs headless |
| `QA_ALLOW_HOSTS` | loopback only | hosts the server may open |
| `QA_NAV_TIMEOUT_MS` | `30000` | page load timeout |
| `QA_ACTION_TIMEOUT_MS` | `5000` | action and wait timeout |
| `QA_CHANNEL` | bundled Chromium | `chrome` or `msedge` |
| `QA_CONFIG` | `./.qa/config.json` | config file location |

## Safety defaults

- **Loopback only.** `stage_open`, `scenario_run`, `goto` steps and `annotate_start` refuse any
  host outside the allow-list.
- **No credentials in URLs.** Embedded `user:pass@` is rejected; secret-looking query values
  (`token`, `key`, `session`, …) are masked in stored URLs.
- **No writes to your source.** Runs land in `qa/`; the tool never edits code, commits, or
  promotes baselines.
- **Artifacts may contain customer data.** Screenshots are of your app. Keep them local and set
  retention if you publish them.

## Storage

```
qa/
  runs/<run_id>/          meta, steps, measurements, captures, diffs
  findings/<run_id>.json  findings with cited evidence
  annotations/<id>/       annotation.json, crops, full frame
  baselines/<scenario>/   promoted reference frames (commit these)
```

## CLI

```
qa-mcp serve                          stdio MCP server
qa-mcp init [--url ...] [--engine ...]  write config + a smoke scenario
qa-mcp doctor                         check the machine before blaming the app
qa-mcp run <scenario|name>            CI entrypoint
qa-mcp gc [--keep 20]                 delete the oldest runs
qa-mcp baseline promote|list          human baseline management
qa-mcp --version
```

## Limits

- Web apps only. Native desktop automation is not implemented.
- No visual AI anywhere: "does this look right" is the agent's job.
- Detector set is small and reviewable; contrast and z-order checks are not implemented.
- One browser instance per server; one active scenario at a time.
- Pixel diffs are only comparable across machines inside the pinned browser image
  (`Dockerfile` matches the `playwright` version).

## Development

```bash
npm run build
npm test          # 21 tests, headless
npm run typecheck
npm run pack:check
```

Source: `src/config.ts` (env, config file, allow-list, redaction), `src/stage.ts` (Playwright
engine), `src/electron-stage.ts` + `electron/main.cjs` (Electron engine), `src/inpage.ts`
(measurement rules), `src/inpage-annotation.ts` (annotation overlay), `src/scenario.ts`,
`src/diff.ts`, `src/annotate.ts`, `src/store.ts`, `src/server.ts` (MCP), `src/cli.ts`.

## License

MIT
