import assert from "node:assert/strict";
import test from "node:test";
import { quotaSummaryItems } from "../src/quotaCatalog";

test("shows documented limits beside this extension's local-only usage", () => {
  const items = quotaSummaryItems(new Map([["glm5.3", { requests: 2, tokens: 250_000 }]]));
  const glm = items.find((item) => item.label === "GLM 5.3");
  assert.ok(glm);
  assert.match(glm.description, /3\.0B tokens per billing period/);
  assert.match(glm.description, /400\.0M tokens per rolling 4h/);
  assert.match(glm.description, /local usage: 250\.0K tokens/);
  assert.match(glm.detail, /not account-wide usage or remaining quota/);
});

test("shows Mimo V2.6 Flash's published monthly quota", () => {
  const items = quotaSummaryItems(new Map());
  const mimo = items.find((item) => item.label === "Xiaomi MiMo V2.6 Flash");
  assert.ok(mimo);
  assert.match(mimo.description, /1\.0B tokens per month/);
  assert.doesNotMatch(mimo.description, /billing period/);
});

test("does not invent an uncapped quota when NaN has not published one", () => {
  const items = quotaSummaryItems(new Map());
  const gemma = items.find((item) => item.label === "Gemma 4");
  assert.ok(gemma);
  assert.match(gemma.description, /No published quota limit/);
  assert.match(gemma.detail, /Account-wide usage and remaining quota are unavailable/);
});

test("includes locally observed unknown models without inventing their limit", () => {
  const items = quotaSummaryItems(new Map([["future-model", { requests: 1, tokens: 1_000 }]]));
  const model = items.find((item) => item.label === "future-model");
  assert.ok(model);
  assert.match(model.description, /No published quota limit/);
  assert.match(model.description, /local usage: 1\.0K tokens/);
});
