import assert from "node:assert/strict";
import test from "node:test";
import { monthlyQuotaProgress, quotaSummaryItems } from "../src/quotaCatalog";

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

test("labels models without a monthly token counter as having no percentage", () => {
  const items = quotaSummaryItems(new Map());
  const gemma = items.find((item) => item.label === "Gemma 4");
  assert.ok(gemma);
  assert.match(gemma.description, /No token counter/);
  assert.match(gemma.description, /^No token counter/);
  assert.match(gemma.detail, /No requests observed by this VS Code extension this session/);
});

test("computes percentages only from documented monthly quotas, most restricted first", () => {
  const rows = monthlyQuotaProgress([
    { model: "deepseek-v4-flash", totalTokens: 500_000_000 }, // 500M / 3B = 16.7%
    { model: "mimo-v2.6-flash", totalTokens: 1_050_000_000 }, // 1.05B / 1B = 105%
    { model: "glm5.3", totalTokens: 1 }, // billing period, not month → excluded
    { model: "gemma4", totalTokens: 1 }, // no token counter → excluded
    { model: "future-model", totalTokens: 1 }, // unknown → excluded
  ]);
  assert.deepEqual(
    rows.map((row) => [row.model, row.percent]),
    [
      ["mimo-v2.6-flash", 105],
      ["deepseek-v4-flash", 16.7],
    ],
  );
  const mimo = rows.find((row) => row.model === "mimo-v2.6-flash");
  assert.ok(mimo);
  assert.equal(mimo.usedTokens, 1_050_000_000);
  assert.equal(mimo.limitTokens, 1_000_000_000);
});

test("includes locally observed unknown models without inventing their limit", () => {
  const items = quotaSummaryItems(new Map([["future-model", { requests: 1, tokens: 1_000 }]]));
  const model = items.find((item) => item.label === "future-model");
  assert.ok(model);
  assert.match(model.description, /No published quota limit/);
  assert.match(model.description, /local usage: 1\.0K tokens/);
});
