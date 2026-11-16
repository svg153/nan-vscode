import assert from "node:assert/strict";
import test from "node:test";
import { creditProgress, percentOf, quotaSummaryItems, roundCredits, sumCredits, unmeteredNote } from "../src/quotaCatalog";

test("shows how each model is billed beside this extension's local-only usage", () => {
  const items = quotaSummaryItems(new Map([["glm5.3", { requests: 2, tokens: 250_000 }]]));
  const glm = items.find((item) => item.label === "GLM 5.3");
  assert.ok(glm);
  assert.match(glm.description, /^Paid from plan credits/);
  assert.match(glm.description, /local usage: 250\.0K tokens/);
  assert.doesNotMatch(glm.description, /per month|per billing period/);
  assert.match(glm.detail, /not account-wide usage or your credit balance/);
});

test("marks the larger models as paid from plan credits", () => {
  const items = quotaSummaryItems(new Map());
  for (const label of ["Kimi K3.1 Pro", "Qwen 3.8 Max", "DeepSeek V4 Pro", "Tencent Hunyuan 4"]) {
    const model = items.find((item) => item.label === label);
    assert.ok(model, `${label} is listed`);
    assert.match(model.description, /^Paid from plan credits/);
  }
});

test("labels models NaN does not meter as drawing no credits", () => {
  const items = quotaSummaryItems(new Map());
  const gemma = items.find((item) => item.label === "Gemma 4");
  assert.ok(gemma);
  assert.match(gemma.description, /^Does not draw credits/);
  assert.match(gemma.detail, /No requests observed by this VS Code extension this session/);
  assert.equal(unmeteredNote("gemma4"), "Does not draw credits");
  assert.equal(unmeteredNote("glm5.3"), undefined);
});

test("includes locally observed unknown models without inventing their allowance", () => {
  const items = quotaSummaryItems(new Map([["future-model", { requests: 1, tokens: 1_000 }]]));
  const model = items.find((item) => item.label === "future-model");
  assert.ok(model);
  assert.match(model.description, /^Billed in credits; no documented allowance/);
  assert.match(model.description, /local usage: 1\.0K tokens/);
});

test("computes each model's share of the plan credit allowance, largest first", () => {
  const rows = creditProgress(
    [
      { model: "deepseek-v4-flash", credits: 1_000 }, // 1,000 / 20,000 = 5%
      { model: "kimi-k3.1-pro", credits: 5_000 }, // 5,000 / 20,000 = 25%
      { model: "gemma4", credits: 9_000 }, // unmetered → excluded even if reported
      { model: "glm5.3", credits: 0 }, // no credits billed → excluded
      { model: "future-model", credits: 1 }, // unknown but metered → 0.0%
    ],
    20_000,
  );
  assert.deepEqual(
    rows.map((row) => [row.model, row.percent]),
    [
      ["kimi-k3.1-pro", 25],
      ["deepseek-v4-flash", 5],
      ["future-model", 0],
    ],
  );
  const kimi = rows.find((row) => row.model === "kimi-k3.1-pro");
  assert.ok(kimi);
  assert.equal(kimi.usedCredits, 5_000);
  assert.equal(kimi.allowance, 20_000);
});

test("sumCredits rounds accumulated credit amounts to the billed precision", () => {
  assert.equal(sumCredits([0.1, 0.2]), 0.3);
  assert.equal(sumCredits([6_154.3, 0.1, 0.1]), 6_154.5);
  assert.equal(sumCredits([]), 0);
  assert.equal(sumCredits([Number.NaN, 2]), 2);
  assert.equal(roundCredits(154.06), 154.1);
  assert.equal(roundCredits(Number.POSITIVE_INFINITY), 0);
});

test("never fabricates a percentage without a positive allowance", () => {
  const entries = [{ model: "kimi-k3.1-pro", credits: 5_000 }];
  assert.deepEqual(creditProgress(entries, undefined), []);
  assert.deepEqual(creditProgress(entries, 0), []);
  assert.deepEqual(creditProgress(entries, Number.NaN), []);
  assert.equal(percentOf(5_000, 20_000), 25);
  assert.equal(percentOf(154, 20_000), 0.8); // one decimal, like NaN's credit amounts
  assert.equal(percentOf(10, 0), 0);
  assert.equal(percentOf(10, -5), 0);
  assert.equal(percentOf(Number.POSITIVE_INFINITY, 20_000), 0);
  assert.equal(percentOf(10, Number.NaN), 0);
});
