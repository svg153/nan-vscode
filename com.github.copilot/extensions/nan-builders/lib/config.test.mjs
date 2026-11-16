import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configPath, loadConfig, saveApiKey, saveBaseUrl } from "./config.mjs";
import { NanError } from "./nan.mjs";

async function freshHome() {
  const dir = await mkdtemp(join(tmpdir(), "nan-cfg-"));
  process.env.COPILOT_HOME = dir;
  delete process.env.NAN_BUILDERS_API_KEY;
  return dir;
}

test("missing config file yields no key and default base URL", async () => {
  await freshHome();
  const cfg = await loadConfig();
  assert.equal(cfg.hasKey, false);
  assert.equal(cfg.baseUrl, "https://api.nan.builders/v1");
});

test("saved key round-trips, empty key clears, env overrides", async () => {
  await freshHome();
  await saveApiKey("  sk-file  ");
  let cfg = await loadConfig();
  assert.equal(cfg.apiKey, "sk-file");
  assert.equal(cfg.hasKey, true);
  assert.equal(cfg.keySource, "config-file");

  process.env.NAN_BUILDERS_API_KEY = "sk-env";
  cfg = await loadConfig();
  assert.equal(cfg.apiKey, "sk-env");
  assert.equal(cfg.keySource, "environment");
  delete process.env.NAN_BUILDERS_API_KEY;

  await saveApiKey("");
  cfg = await loadConfig();
  assert.equal(cfg.hasKey, false);
});

test("config file is written under the plugin artifacts path", async () => {
  const dir = await freshHome();
  await saveApiKey("sk-x");
  const raw = JSON.parse(await readFile(configPath(), "utf8"));
  assert.equal(raw.apiKey, "sk-x");
  assert.ok(configPath().startsWith(join(dir, "extensions", "nan-builders", "artifacts")));
});

test("remote plain HTTP requires confirmation; loopback and https do not", async () => {
  await freshHome();
  await assert.rejects(
    saveBaseUrl("http://example.com/v1"),
    (error) => error instanceof NanError && error.kind === "confirmation_required",
  );
  const saved = await saveBaseUrl("http://example.com/v1", { confirmInsecure: true });
  assert.equal(saved.insecure, true);
  let cfg = await loadConfig();
  assert.equal(cfg.baseUrl, "http://example.com/v1");
  assert.equal(cfg.insecureConfirmed, true);

  await saveBaseUrl("http://127.0.0.1:8787/v1");
  cfg = await loadConfig();
  assert.equal(cfg.insecureConfirmed, false);

  await saveBaseUrl("https://api.nan.builders/v1/");
  cfg = await loadConfig();
  assert.equal(cfg.baseUrl, "https://api.nan.builders/v1");
  const raw = JSON.parse(await readFile(configPath(), "utf8"));
  assert.equal(raw.baseUrl, undefined); // default is not stored
});

test("invalid base URL is rejected", async () => {
  await freshHome();
  await assert.rejects(
    saveBaseUrl("not a url"),
    (error) => error instanceof NanError && error.kind === "bad_request",
  );
});
