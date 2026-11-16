import test from "node:test";
import assert from "node:assert/strict";
import {
  compactTokens,
  monthlyQuotaProgress,
  nonMonthlyQuotaNote,
  quotaCapLabel,
} from "./quota.mjs";

test("monthlyQuotaProgress only covers documented fixed monthly counters", () => {
  const progress = monthlyQuotaProgress([
    { model: "qwen3.8-flash", totalTokens: 250_000_000 },
    { model: "glm5.3", totalTokens: 1_500_000_000 }, // billing period, not monthly
    { model: "gemma4", totalTokens: 10 }, // no counter
    { model: "deepseek-v4-flash", totalTokens: 3_000_000_000 },
    { model: "some-new-model", totalTokens: 999 }, // no published cap
  ]);
  assert.deepEqual(progress.map((p) => p.model), ["deepseek-v4-flash", "qwen3.8-flash"]);
  assert.equal(progress[0].percent, 100);
  assert.equal(progress[1].percent, 50);
});

test("percent is rounded to one decimal", () => {
  const [entry] = monthlyQuotaProgress([{ model: "qwen3.8-flash", totalTokens: 123_456_789 }]);
  assert.equal(entry.percent, 24.7);
});

test("non-monthly quotas produce notes, never percentages", () => {
  assert.equal(nonMonthlyQuotaNote("glm5.3"), "3.0B tokens per billing period · 400.0M tokens per rolling 4h (not a fixed monthly counter)");
  assert.equal(nonMonthlyQuotaNote("qwen3.8-flash"), undefined);
  assert.equal(quotaCapLabel("gemma4"), "No token counter");
  assert.equal(quotaCapLabel("glm5.3"), "3.0B tokens per billing period · 400.0M tokens per rolling 4h");
  assert.equal(quotaCapLabel("brand-new-model"), "No published quota limit");
});

test("compactTokens picks the largest readable unit", () => {
  assert.equal(compactTokens(1_500_000_000), "1.5B tokens");
  assert.equal(compactTokens(2_000_000), "2.0M tokens");
  assert.equal(compactTokens(1_234), "1.2K tokens");
  assert.equal(compactTokens(999), "999 tokens");
});
