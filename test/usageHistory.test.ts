import assert from "node:assert/strict";
import test from "node:test";
import { addUsage, normalizeHistory, type DailyUsage } from "../src/usageHistory";

const today = "2026-09-24";

test("aggregates requests and reported token counts by UTC day and model", () => {
  const history = addUsage([], "glm5.3-flash", { prompt_tokens: 10, completion_tokens: 4 }, today);
  const repeated = addUsage(history, "glm5.3-flash", undefined, today);
  assert.deepEqual(repeated, [{
    date: today,
    modelId: "glm5.3-flash",
    requests: 2,
    promptTokens: 10,
    completionTokens: 4,
  }]);
});

test("drops expired, malformed, and excess history records", () => {
  const input: unknown = [
    { date: "2026-08-24", modelId: "old", requests: 1, promptTokens: 1, completionTokens: 1 },
    { date: today, modelId: "ok", requests: 1, promptTokens: 2, completionTokens: 3 },
    { date: today, modelId: "bad", requests: -1, promptTokens: 0, completionTokens: 0 },
    { date: "not-a-date", modelId: "bad", requests: 1, promptTokens: 0, completionTokens: 0 },
    { date: "2026-02-31", modelId: "bad", requests: 1, promptTokens: 0, completionTokens: 0 },
  ];
  assert.deepEqual(normalizeHistory(input, today), [{
    date: today,
    modelId: "ok",
    requests: 1,
    promptTokens: 2,
    completionTokens: 3,
  }] satisfies DailyUsage[]);
  assert.deepEqual(normalizeHistory({ unexpected: true }, today), []);
});

test("bounds retained data to 30 days and 1000 model/day rows", () => {
  const many: DailyUsage[] = Array.from({ length: 1001 }, (_, i) => ({
    date: today,
    modelId: `model-${i}`,
    requests: 1,
    promptTokens: 0,
    completionTokens: 0,
  }));
  assert.equal(normalizeHistory(many, today).length, 1000);
});
