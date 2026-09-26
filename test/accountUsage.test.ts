import assert from "node:assert/strict";
import test from "node:test";
import { AccountUsageService, accountHeadline, accountModelRows } from "../src/accountUsage";
import { UsageApiError, parseUsageReport, type UsageReport } from "../src/usageApi";

const TODAY = "2026-09-18";
const CONFIG = { baseUrl: "https://api.nan.builders/v1", apiKey: "nan_test_key" };

function reportPayload(byModel: Array<{ model: string; totalTokens: number }> = []): Record<string, unknown> {
  return {
    object: "usage.report",
    start_date: "2026-09-01",
    end_date: TODAY,
    data: [],
    totals: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: byModel.reduce((sum, entry) => sum + entry.totalTokens, 0),
      api_requests: 0,
      by_model: byModel.map((entry) => ({
        model: entry.model,
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: entry.totalTokens,
        api_requests: 0,
      })),
    },
    all_time: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      api_requests: 0,
      cached_at: `${TODAY}T06:00:00Z`,
    },
    has_more: false,
    next_cursor: null,
  };
}

function reportWith(byModel: Array<{ model: string; totalTokens: number }>): UsageReport {
  return parseUsageReport(reportPayload(byModel));
}

function okFetch(calls: { count: number }): typeof fetch {
  return async () => {
    calls.count += 1;
    return new Response(JSON.stringify(reportPayload()), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

test("refresh stores a snapshot for the current-month window ending today", async () => {
  const calls: { count: number } = { count: 0 };
  const service = new AccountUsageService(() => CONFIG);
  const snapshot = await service.refresh({ today: TODAY, fetchImpl: okFetch(calls) });
  assert.equal(snapshot.startDate, "2026-09-01");
  assert.equal(snapshot.endDate, TODAY);
  assert.equal(snapshot.report.totals.totalTokens, 0);
  assert.equal(service.loading, false);
  assert.equal(service.lastError, undefined);
  assert.equal(calls.count, 1);
});

test("a failed refresh keeps the previous snapshot and records lastError", async () => {
  const service = new AccountUsageService(() => CONFIG);
  const first = await service.refresh({ today: TODAY, fetchImpl: okFetch({ count: 0 }) });
  await assert.rejects(
    service.refresh({
      today: TODAY,
      force: true,
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: { message: "boom" } }), {
          status: 500,
          statusText: "Internal Server Error",
        }),
    }),
    (error: unknown) => error instanceof UsageApiError && error.kind === "server",
  );
  assert.equal(service.snapshot, first);
  const lastError = service.lastError;
  assert.ok(lastError);
  assert.match(lastError.message, /failed/);
  assert.ok(Number.isFinite(Date.parse(lastError.at)));
  assert.equal(service.loading, false);
});

test("missing API key fails with unauthorized and records lastError", async () => {
  const calls: { count: number } = { count: 0 };
  const service = new AccountUsageService(() => undefined);
  await assert.rejects(
    service.refresh({ today: TODAY, fetchImpl: okFetch(calls) }),
    (error: unknown) => error instanceof UsageApiError && error.kind === "unauthorized",
  );
  assert.equal(calls.count, 0);
  assert.ok(service.lastError);
});

test("throttles refreshes within 60s unless forced", async () => {
  const firstCalls: { count: number } = { count: 0 };
  const secondCalls: { count: number } = { count: 0 };
  const service = new AccountUsageService(() => CONFIG);
  const first = await service.refresh({ today: TODAY, fetchImpl: okFetch(firstCalls) });
  const throttled = await service.refresh({ today: TODAY, fetchImpl: okFetch(secondCalls) });
  assert.equal(throttled, first);
  assert.equal(firstCalls.count, 1);
  assert.equal(secondCalls.count, 0);

  const forced = await service.refresh({ today: TODAY, force: true, fetchImpl: okFetch(secondCalls) });
  assert.equal(secondCalls.count, 1);
  assert.notEqual(forced, first);
});

test("cancellation is rethrown without recording lastError", async () => {
  const service = new AccountUsageService(() => CONFIG);
  const abortError = new Error("The operation was aborted.");
  abortError.name = "AbortError";
  const fetchImpl: typeof fetch = async () => {
    throw abortError;
  };
  await assert.rejects(
    service.refresh({ today: TODAY, fetchImpl }),
    (error: unknown) => error === abortError,
  );
  assert.equal(service.lastError, undefined);
});

test("blocks the 31st usage query within a minute with a rate_limited error", async () => {
  const calls: { count: number } = { count: 0 };
  const service = new AccountUsageService(() => CONFIG);
  for (let i = 0; i < 30; i += 1) {
    await service.refresh({ today: TODAY, force: true, fetchImpl: okFetch(calls) });
  }
  await assert.rejects(
    service.refresh({ today: TODAY, force: true, fetchImpl: okFetch(calls) }),
    (error: unknown) =>
      error instanceof UsageApiError &&
      error.kind === "rate_limited" &&
      (error.retryAfterSeconds ?? 0) >= 1,
  );
  assert.equal(calls.count, 30);
});

test("accountModelRows sorts by tokens and only documents monthly percentages", () => {
  const report = reportWith([
    { model: "gemma4", totalTokens: 456 },
    { model: "glm5.3", totalTokens: 123 },
    { model: "deepseek-v4-flash", totalTokens: 150_000_000 },
    { model: "mimo-v2.6-flash", totalTokens: 1_100_000_000 },
  ]);
  const rows = accountModelRows(report);
  assert.deepEqual(
    rows.map((row) => row.model),
    ["mimo-v2.6-flash", "deepseek-v4-flash", "gemma4", "glm5.3"],
  );
  assert.equal(rows[0].percent, 110);
  assert.equal(rows[1].percent, 5);
  assert.equal(rows[2].percent, undefined);
  assert.equal(rows[2].note, "No token counter");
  assert.equal(rows[3].percent, undefined);
  assert.match(rows[3].note ?? "", /not a fixed monthly counter/);
});

test("accountHeadline picks the most restricted monthly quota and never fabricates one", () => {
  const headline = accountHeadline(
    reportWith([
      { model: "deepseek-v4-flash", totalTokens: 500_000_000 },
      { model: "mimo-v2.6-flash", totalTokens: 1_100_000_000 },
    ]),
  );
  assert.deepEqual(headline, { model: "mimo-v2.6-flash", percent: 110 });

  assert.equal(accountHeadline(reportWith([{ model: "glm5.3", totalTokens: 10 }])), undefined);
  assert.equal(accountHeadline(reportWith([{ model: "gemma4", totalTokens: 10 }])), undefined);
});
