import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate every artifact this test produces.
process.env.QA_HOME = await mkdtemp(join(tmpdir(), "qa-mcp-test-"));
// Exercise the CI path: no desktop, no window.
process.env.QA_HEADLESS = "1";

const { StageManager } = await import("../dist/stage.js");
const { runScenario } = await import("../dist/scenario.js");
const { diffAgainstBaseline } = await import("../dist/diff.js");
const store = await import("../dist/store.js");
const { listAnnotations, resolveAnnotation, getAnnotation } = await import("../dist/annotate.js");

const manager = new StageManager();
let server;
let baseUrl;
let run;

/**
 * Test fixture: a page with exactly the defects the detectors and the agent are
 * expected to find. Served inline so the repository carries no demo app.
 */
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Fixture checkout</title>
<style>
  body { margin: 0; font: 15px/1.5 system-ui, sans-serif; background: #f7f6f2; color: #1c2430; }
  main { max-width: 960px; margin: 0 auto; padding: 28px 24px; }
  .promo { width: 190px; overflow: hidden; white-space: nowrap; border: 1px dashed #c9c2b4; padding: 8px 10px; }
  #wide-banner { width: 1500px; height: 46px; background: repeating-linear-gradient(90deg, #dbe7df 0 24px, #eef3ef 24px 48px); }
  .card { background: #fff; border: 1px solid #e4e7ec; border-radius: 12px; padding: 18px; margin-top: 24px; max-width: 520px; }
  .thumb { width: 240px; height: 150px; display: block; background: #eef1f4; }
  #tiny { width: 12px; height: 12px; padding: 0; font-size: 8px; }
  input { width: 100%; box-sizing: border-box; padding: 9px 10px; }
  #place-order { background: #2f6f4f; color: #fff; border: 0; padding: 10px 16px; border-radius: 8px; }
  .fail { color: #b42318; font-weight: 600; }
</style></head>
<body><main>
  <div class="promo">SPRING-SALE-2026-FREE-DELIVERY-OVER-40-POUNDS</div>
  <div id="wide-banner"></div>
  <section class="card">
    <img class="thumb" src="/assets/product.png" alt="Ceramic mug">
    <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='72' height='24'%3E%3Crect width='72' height='24' fill='%232f6f4f'/%3E%3C/svg%3E">
    <h1>Checkout</h1>
    <label for="card">Card number</label>
    <input id="card" value="4242 4242 4242 4242">
    <button id="place-order">Place order</button>
    <div id="status"></div>
    <button id="tiny" aria-label="Remove item">x</button>
  </section>
</main>
<script>
  console.error("hydration mismatch: expected <span> but found <div>");
  fetch("/api/orders").catch(function () {});
  document.getElementById("place-order").addEventListener("click", function () {
    var status = document.getElementById("status");
    status.className = "fail";
    status.textContent = "Order failed: card declined";
    console.error("POST /api/orders -> 402 card_declined");
  });
</script>
</body></html>`;

const spec = {
  name: "checkout",
  url: "",
  viewport: { width: 1280, height: 800 },
  steps: [
    { action: "goto", value: "/" },
    { action: "capture", name: "home" },
    { action: "click", selector: "#place-order" },
    { action: "wait_for", selector: "#status" },
    { action: "capture", name: "after-order" },
  ],
};

before(async () => {
  server = createServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
    } else {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  baseUrl = `http://127.0.0.1:${server.address().port}/`;
  run = await runScenario(manager, { ...spec, url: baseUrl });
});

after(async () => {
  await manager.closeAll();
  await new Promise((done) => server.close(done));
});

function rule(name) {
  return run.measurements.measurements.find((m) => m.rule === name);
}

test("every step executes as written", () => {
  assert.equal(run.steps.length, 5);
  assert.deepEqual(run.steps.map((s) => s.action), ["goto", "capture", "click", "wait_for", "capture"]);
  assert.ok(run.steps.every((s) => s.ok), JSON.stringify(run.steps, null, 2));
});

test("captures are written to disk", async () => {
  for (const name of ["home", "after-order", "final"]) {
    const png = await readFile(join(run.artifacts.dir, "captures", `${name}.png`));
    assert.ok(png.length > 5000, `${name} looks empty`);
    assert.equal(png.subarray(1, 4).toString(), "PNG");
  }
});

test("detectors report the seeded layout flaws", () => {
  const overflow = rule("horizontal_overflow");
  assert.equal(overflow.count, 1);
  assert.equal(overflow.items[0].selector, "#wide-banner");
  assert.ok(overflow.items[0].overflow_px > 0);

  const broken = rule("broken_images");
  assert.equal(broken.count, 1);
  assert.match(broken.items[0].src, /product\.png$/);

  const alt = rule("images_missing_alt");
  assert.equal(alt.count, 1);

  const tiny = rule("small_targets");
  assert.equal(tiny.count, 1);
  assert.equal(tiny.items[0].selector, "#tiny");

  const clipped = rule("clipped_text");
  assert.ok(clipped.count >= 1);
  assert.ok(clipped.items.some((i) => i.text.startsWith("SPRING-SALE")));
});

test("runtime errors are collected, not judged", () => {
  const kinds = new Set(run.measurements.runtime.map((e) => e.kind));
  assert.ok(kinds.has("console_error"), "expected a console error");
  assert.ok(kinds.has("http_error"), "expected a failing request");
  assert.ok(run.measurements.runtime.every((e) => typeof e.text === "string"));
});

test("findings without evidence are rejected", async () => {
  await assert.rejects(
    () => store.saveFindings(run.run_id, [{ claim: "looks bad", evidence: [] }]),
    /no evidence reference/,
  );
  const saved = await store.saveFindings(run.run_id, [
    { selector: "#place-order", claim: "order fails after submit", evidence: ["captures/after-order.png"] },
  ]);
  assert.equal(saved.ids.length, 1);
  const payload = JSON.parse(await readFile(saved.file, "utf8"));
  assert.equal(payload.findings.length, 1);
});

test("diff reports a missing baseline instead of guessing", async () => {
  const result = await diffAgainstBaseline({ runId: run.run_id, name: "home", scenario: "checkout" });
  assert.equal(result.changed_pixels, null);
  assert.match(result.note, /no baseline/);
});

test("a promoted baseline produces a zero-pixel diff", async () => {
  const promoted = await store.promoteBaseline(run.run_id, "home", "checkout");
  assert.ok(promoted.endsWith(".png"));
  const result = await diffAgainstBaseline({ runId: run.run_id, name: "home", scenario: "checkout" });
  assert.equal(result.size_match, true);
  assert.equal(result.changed_pixels, 0);
});

test("annotations resolve and list", async () => {
  const id = "ann-test-1";
  await mkdir(join(store.dirs.annotations, id), { recursive: true });
  await writeFile(
    join(store.dirs.annotations, id, "annotation.json"),
    JSON.stringify({
      annotation_id: id,
      status: "ready",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      url: "http://example.test/",
      viewport: { width: 1280, height: 800 },
      marks: [
        {
          n: 1,
          shape: "box",
          rect: { x: 1, y: 2, w: 3, h: 4 },
          note: "text is clipped",
          element: {
            selector: ".promo",
            tag: "div",
            role: null,
            name: "SPRING-SALE",
            box: { x: 1, y: 2, w: 3, h: 4 },
            resolution: "exact",
          },
        },
      ],
      crops: [],
      full: null,
      resolution_note: null,
      note: "1 mark(s) from the user",
    }),
  );

  const listed = await listAnnotations("ready");
  assert.ok(listed.some((a) => a.annotation_id === id));

  const resolved = await resolveAnnotation(id, "widened the container");
  assert.equal(resolved.status, "resolved");
  const again = await getAnnotation(id);
  assert.equal(again.resolution_note, "widened the container");
});

test("the annotation overlay turns a drawn box into a note plus element", async () => {
  const { ANNOTATION_SCRIPT } = await import("../dist/inpage-annotation.js");
  const stage = await manager.open({ url: baseUrl, hidden: true });
  try {
    await manager.evaluate(stage.stage_id, ANNOTATION_SCRIPT);
    const overlay = await manager.evaluate(
      stage.stage_id,
      `(() => {
        const layer = document.getElementById("__qa_layer");
        const box = document.getElementById("tiny").getBoundingClientRect();
        const x0 = Math.round(box.x - 2), y0 = Math.round(box.y - 2);
        const x1 = Math.round(box.right + 2), y1 = Math.round(box.bottom + 2);
        const fire = (type, x, y) =>
          layer.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }));
        fire("mousedown", x0, y0);
        fire("mousemove", x1, y1);
        fire("mouseup", x1, y1);
        const input = document.getElementById("__qa_note");
        input.value = "remove control is tiny";
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        document.getElementById("__qa_send").click();
        return window.__qaAnnotation;
      })()`,
    );
    assert.equal(overlay.status, "sent");
    assert.equal(overlay.marks.length, 1);
    assert.equal(overlay.marks[0].note, "remove control is tiny");
    assert.equal(overlay.marks[0].element.tag, "button");
    assert.ok(overlay.marks[0].element.selector.includes("tiny"));
  } finally {
    await manager.close(stage.stage_id);
  }
});

test("parallel findings writes do not lose each other", async () => {
  const findingsFile = store.dirs.findings + `/${run.run_id}.json`;
  const before = JSON.parse(await readFile(findingsFile, "utf8")).findings.length;
  const writes = Array.from({ length: 12 }, (_, i) =>
    store.saveFindings(run.run_id, [
      { claim: `concurrent finding ${i}`, evidence: ["captures/home.png"] },
    ]),
  );
  await Promise.all(writes);
  const payload = JSON.parse(await readFile(findingsFile, "utf8"));
  assert.equal(payload.findings.length, before + 12);
});

test("garbage collection keeps the newest runs", async () => {
  const fake = async (name) => {
    await mkdir(join(store.dirs.runs, name), { recursive: true });
    await writeFile(join(store.dirs.runs, name, "meta.json"), JSON.stringify({ run_id: name }));
  };
  await fake("run-fake-old");
  await new Promise((r) => setTimeout(r, 20));
  await fake("run-fake-new");

  const result = await store.collectGarbage(1);
  assert.ok(result.removed.includes("run-fake-old"));
  assert.ok(!result.removed.includes("run-fake-new"));
  assert.equal(result.kept, 1);
});
