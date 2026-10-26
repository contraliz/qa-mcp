import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

const { assertAllowedUrl, redactUrl, headlessMode, allowedHosts } = await import("../dist/config.js");

const saved = { ...process.env };

afterEach(() => {
  for (const key of ["QA_ALLOW_HOSTS", "QA_HEADLESS", "CI"]) delete process.env[key];
  Object.assign(process.env, saved);
});

test("loopback is allowed by default", () => {
  assert.equal(assertAllowedUrl("http://127.0.0.1:4173/").hostname, "127.0.0.1");
  assert.equal(assertAllowedUrl("http://localhost:5173/app").port, "5173");
});

test("external hosts are refused by default", () => {
  assert.throws(
    () => assertAllowedUrl("https://example.com/"),
    /not allowed by QA_ALLOW_HOSTS/,
  );
});

test("QA_ALLOW_HOSTS narrows or widens deliberately", () => {
  process.env.QA_ALLOW_HOSTS = "example.com";
  assert.equal(assertAllowedUrl("https://example.com/x").hostname, "example.com");
  assert.throws(() => assertAllowedUrl("http://127.0.0.1:4173/"), /not allowed/);

  process.env.QA_ALLOW_HOSTS = "*.example.com";
  assert.equal(assertAllowedUrl("https://api.example.com/x").hostname, "api.example.com");
  assert.throws(() => assertAllowedUrl("https://example.com/x"), /not allowed/);

  process.env.QA_ALLOW_HOSTS = "*";
  assert.equal(assertAllowedUrl("https://anything.test/").hostname, "anything.test");
});

test("port-specific entries require the port", () => {
  process.env.QA_ALLOW_HOSTS = "127.0.0.1:4173";
  assert.equal(assertAllowedUrl("http://127.0.0.1:4173/").port, "4173");
  assert.throws(() => assertAllowedUrl("http://127.0.0.1:9999/"), /not allowed/);
});

test("scheme and credentials are validated", () => {
  assert.throws(() => assertAllowedUrl("file:///etc/passwd"), /only http and https/);
  assert.throws(() => assertAllowedUrl("ftp://127.0.0.1/"), /only http and https/);
  assert.throws(() => assertAllowedUrl("http://user:pass@127.0.0.1/"), /embedded credentials/);
  assert.throws(() => assertAllowedUrl("not a url"), /not a valid URL/);
});

test("redaction removes credentials and secret query values", () => {
  const url = redactUrl("http://user:pass@127.0.0.1:3000/cb?access_token=abc123&page=2&api_key=k");
  assert.ok(!url.includes("user"));
  assert.ok(!url.includes("pass"));
  assert.ok(!url.includes("abc123"));
  assert.ok(url.includes("page=2"));
  assert.ok(url.includes("%5Bredacted%5D") || url.includes("[redacted]"));
});

test("headless defaults on under CI and follows an explicit flag", () => {
  delete process.env.QA_HEADLESS;
  delete process.env.CI;
  assert.equal(headlessMode(), false);

  process.env.CI = "true";
  assert.equal(headlessMode(), true);

  process.env.QA_HEADLESS = "0";
  assert.equal(headlessMode(), false);

  process.env.QA_HEADLESS = "1";
  assert.equal(headlessMode(), true);
});

test("annotations refuse to start without a visible window", async () => {
  process.env.QA_HEADLESS = "1";
  const { startAnnotation } = await import("../dist/annotate.js");
  await assert.rejects(
    () => startAnnotation({}, { url: "http://127.0.0.1:4173/" }),
    /visible window/,
  );
});

test("allow list defaults to loopback only", () => {
  delete process.env.QA_ALLOW_HOSTS;
  assert.deepEqual(allowedHosts(), ["localhost", "127.0.0.1", "::1", "[::1]"]);
});

test(".qa/config.json is honoured and env still wins", async () => {
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const config = await import("../dist/config.js");
  const { engineName } = await import("../dist/engine.js");

  const dir = await mkdtemp(join(tmpdir(), "qa-config-"));
  await mkdir(join(dir, ".qa"), { recursive: true });
  await writeFile(
    join(dir, ".qa", "config.json"),
    JSON.stringify({
      baseUrl: "https://app.example.com/",
      engine: "electron",
      allowHosts: ["app.example.com"],
      headless: false,
      qaHome: "artifacts",
      viewport: { width: 800, height: 600 },
    }),
  );

  const previous = process.cwd();
  process.chdir(dir);
  try {
    const cfg = config.loadConfig();
    assert.equal(cfg.baseUrl, "https://app.example.com/");
    assert.deepEqual(config.defaultViewport(), { width: 800, height: 600 });
    assert.equal(config.qaHome(), join(dir, "artifacts"));
    assert.deepEqual(config.allowedHosts(), ["app.example.com"]);
    assert.equal(config.assertAllowedUrl("https://app.example.com/x").hostname, "app.example.com");
    assert.throws(() => config.assertAllowedUrl("http://127.0.0.1/"), /not allowed/);
    assert.equal(engineName(), "electron");

    // Environment beats the file, in both directions.
    process.env.QA_ENGINE = "playwright";
    assert.equal(engineName(), "playwright");
    process.env.QA_ALLOW_HOSTS = "*";
    assert.equal(config.allowedHosts(), "*");
  } finally {
    process.chdir(previous);
  }

  // A broken file is loud, never silently ignored.
  await writeFile(join(dir, ".qa", "config.json"), "{ nope");
  const broken = { ...process.env };
  process.chdir(dir);
  try {
    assert.throws(() => config.loadConfig(), /invalid qa config/);
  } finally {
    process.chdir(previous);
    Object.assign(process.env, broken);
  }
});
