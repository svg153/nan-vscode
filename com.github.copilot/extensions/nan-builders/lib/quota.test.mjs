import test from "node:test";
import assert from "node:assert/strict";
import {
  compactTokens,
  composeUsage,
  creditProgress,
  creditsNote,
  creditsView,
  formatCredits,
  percentOf,
  quotaCapLabel,
  sumCredits,
  unmeteredNote,
  windowCredits,
} from "./quota.mjs";

const ALLOWANCE = 7000;
const PERIOD = { allowance: ALLOWANCE, used: 1234.5, remaining: 5765.5, periodStart: "2026-11-01", periodEnd: "2026-12-01" };

function report({ byModel = [], credits } = {}) {
  const rows = byModel.map((entry) => ({
    promptTokens: 0,
    completionTokens: 0,
    apiRequests: 0,
    totalTokens: 0,
    ...entry,
  }));
  return {
    startDate: "2026-11-01",
    endDate: "2026-11-16",
    truncated: false,
    credits,
    totals: {
      promptTokens: 0,
      completionTokens: 0,
      apiRequests: rows.reduce((total, row) => total + row.apiRequests, 0),
      totalTokens: rows.reduce((total, row) => total + row.totalTokens, 0),
      byModel: rows,
    },
  };
}

test("creditProgress measures each model against the plan allowance", () => {
  const progress = creditProgress(
    [
      { model: "deepseek-v4-flash", credits: 45.5 },
      { model: "glm5.3", credits: 120 },
      { model: "gemma4", credits: 999 }, // unmetered: never a percentage
      { model: "brand-new-model", credits: 0 }, // nothing billed in the window
    ],
    ALLOWANCE,
  );
  assert.deepEqual(progress.map((entry) => entry.model), ["glm5.3", "deepseek-v4-flash"]);
  assert.equal(progress[0].percent, 1.7);
  assert.equal(progress[0].usedCredits, 120);
  assert.equal(progress[0].allowance, ALLOWANCE);
  assert.equal(progress[1].percent, 0.7);
});

test("creditProgress never fabricates a percentage without a usable allowance", () => {
  assert.deepEqual(creditProgress([{ model: "glm5.3", credits: 10 }], undefined), []);
  assert.deepEqual(creditProgress([{ model: "glm5.3", credits: 10 }], 0), []);
  assert.deepEqual(creditProgress([{ model: "glm5.3", credits: 10 }], Number.NaN), []);
});

test("percentOf and credit helpers keep NaN's one-decimal precision", () => {
  assert.equal(percentOf(1, 3), 33.3);
  assert.equal(percentOf(5, 0), 0);
  assert.equal(percentOf(Number.NaN, 10), 0);
  assert.equal(formatCredits(1234.5), "1234.5");
  assert.equal(formatCredits(7000), "7000");
  assert.equal(formatCredits(Number.NaN), "0");
  assert.equal(sumCredits([0.1, 0.2]), 0.3);
  assert.equal(sumCredits([1, Number.NaN, 2]), 3);
});

test("windowCredits sums the billed rows and is undefined when nothing was billed", () => {
  assert.equal(windowCredits([{ credits: 0.1 }, { credits: 0.2 }, {}]), 0.3);
  assert.equal(windowCredits([{ credits: 0 }, { credits: undefined }]), undefined);
});

test("unmetered models carry the published note, never a percentage", () => {
  for (const model of ["qwen3.6", "gemma4", "qwen3-embedding", "rerank", "kokoro", "whisper", "flux-2-klein", "qwen-image-2.1"]) {
    assert.equal(unmeteredNote(model), "Does not draw credits", model);
    assert.equal(quotaCapLabel(model), "Does not draw credits", model);
  }
  assert.equal(unmeteredNote("glm5.3"), undefined);
  assert.equal(quotaCapLabel("glm5.3"), "Paid from plan credits");
  assert.equal(quotaCapLabel("brand-new-model"), "Billed in credits; no documented allowance");
  assert.equal(creditsNote("gemma4", 0), "Does not draw credits");
  assert.equal(creditsNote("glm5.3", 0), "No credits billed in this window");
  assert.equal(creditsNote("glm5.3", 2.5), undefined);
});

test("creditsView exposes the period headline from the API credits block", () => {
  assert.deepEqual(creditsView(PERIOD), {
    allowance: ALLOWANCE,
    used: 1234.5,
    remaining: 5765.5,
    packCredits: null,
    packExpiresAt: null,
    periodStart: "2026-11-01",
    periodEnd: "2026-12-01",
    frozen: false,
    percent: 17.6,
  });
  assert.equal(creditsView(undefined), null);
});

test("creditsView reports the optional credit pack", () => {
  const view = creditsView({ ...PERIOD, pack_credits: 500, pack_expires_at: "2027-01-01" });
  assert.equal(view.packCredits, null); // snake_case is normalized by lib/nan.mjs, not here
  assert.equal(view.packExpiresAt, null);
  const normalized = creditsView({ ...PERIOD, packCredits: 500, packExpiresAt: "2027-01-01" });
  assert.equal(normalized.packCredits, 500);
  assert.equal(normalized.packExpiresAt, "2027-01-01");
});

test("composeUsage renders the credit headline and every per-model row", () => {
  const usage = composeUsage(
    report({
      credits: PERIOD,
      byModel: [
        { model: "glm5.3", totalTokens: 900_000, apiRequests: 12, credits: 120 },
        { model: "gemma4", totalTokens: 50_000, apiRequests: 3, credits: 0 },
        { model: "some-new-model", totalTokens: 10, apiRequests: 1, credits: 0 },
      ],
    }),
  );
  assert.equal(usage.credits.percent, 17.6);
  assert.equal(usage.windowCredits, 120);
  assert.equal(usage.items.length, 3);

  const [glm, gemma, unknown] = usage.items;
  assert.equal(glm.model, "glm5.3");
  assert.equal(glm.credits, 120);
  assert.equal(glm.percent, 1.7);
  assert.equal(glm.note, undefined);

  assert.equal(gemma.percent, null);
  assert.equal(gemma.note, "Does not draw credits");

  assert.equal(unknown.model, "some-new-model");
  assert.equal(unknown.percent, null);
  assert.equal(unknown.note, "No credits billed in this window");
  assert.equal(unknown.cap, "Billed in credits; no documented allowance");
});

test("composeUsage renders a model unknown to the local catalog without filtering it", () => {
  const usage = composeUsage(
    report({ credits: PERIOD, byModel: [{ model: "future-model-9", totalTokens: 42, credits: 7 }] }),
  );
  assert.equal(usage.items.length, 1);
  assert.equal(usage.items[0].model, "future-model-9");
  assert.equal(usage.items[0].percent, 0.1);
  assert.equal(usage.items[0].credits, 7);
});

test("composeUsage suppresses every percentage while the pool is frozen", () => {
  const usage = composeUsage(
    report({
      credits: { ...PERIOD, frozen: true },
      byModel: [{ model: "glm5.3", totalTokens: 900_000, credits: 120 }],
    }),
  );
  assert.equal(usage.credits.frozen, true);
  assert.equal(usage.credits.percent, null);
  assert.equal(usage.items[0].percent, null);
  assert.equal(usage.items[0].credits, 120);
  assert.equal(usage.items[0].note, undefined);
});

test("composeUsage tolerates a gateway without the credits block", () => {
  const usage = composeUsage(
    report({ credits: undefined, byModel: [{ model: "deepseek-v4-flash", totalTokens: 1234, credits: 0 }] }),
  );
  assert.equal(usage.credits, null);
  assert.equal(usage.windowCredits, null);
  assert.equal(usage.items[0].percent, null);
  assert.equal(usage.items[0].note, "No credits billed in this window");
});

test("compactTokens picks the largest readable unit", () => {
  assert.equal(compactTokens(1_500_000_000), "1.5B tokens");
  assert.equal(compactTokens(2_000_000), "2.0M tokens");
  assert.equal(compactTokens(1_234), "1.2K tokens");
  assert.equal(compactTokens(999), "999 tokens");
});
