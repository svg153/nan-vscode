import assert from "node:assert/strict";
import test from "node:test";
import { AccountUsageService, accountHeadline, accountModelRows, windowCredits } from "../src/accountUsage";
import { UsageApiError, parseUsageReport, type UsageReport } from "../src/usageApi";

const TODAY = "2026-09-18";
const CONFIG = { baseUrl: "https://api.nan.builders/v1", apiKey: "nan_test_key" };

interface ModelUsage {
  readonly model: string;
  readonly totalTokens: number;
  readonly credits?: number;
  readonly cachedTokens?: number;
}

function reportPayload(
  byModel: readonly ModelUsage[] = [],
  credits: Record<string, unknown> | null = null,
): Record<string, unknown> {
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
      credits: byModel.reduce((sum, entry) => sum + (entry.credits ?? 0), 0),
      by_model: byModel.map((entry) => ({
        model: entry.model,
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: entry.totalTokens,
        api_requests: 0,
        credits: entry.credits,
        cached_tokens: entry.cachedTokens,
      })),
    },
    credits,
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

function reportWith(
  byModel: readonly ModelUsage[],
  credits: Record<string, unknown> | null = null,
): UsageReport {
  return parseUsageReport(reportPayload(byModel, credits));
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

test("a stalled refresh times out, aborts the request, and keeps the previous snapshot", async (t) => {
  const service = new AccountUsageService(() => CONFIG);
  const snapshot = await service.refresh({ today: TODAY, fetchImpl: okFetch({ count: 0 }) });
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let requestSignal: AbortSignal | null | undefined;
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const pending = service.refresh({
    today: TODAY,
    force: true,
    fetchImpl: async (_input, init) => {
      requestSignal = init?.signal;
      markStarted();
      return new Promise<Response>(() => {});
    },
  });
  await started;
  assert.equal(service.loading, true);
  t.mock.timers.tick(30_000);

  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof UsageApiError &&
      error.kind === "timeout" &&
      error.message === "NaN Builders usage refresh timed out after 30 seconds.",
  );
  assert.equal(requestSignal?.aborted, true);
  assert.equal(service.loading, false);
  assert.equal(service.snapshot, snapshot);
  assert.equal(service.lastError?.message, "NaN Builders usage refresh timed out after 30 seconds.");
});

test("successful refresh disposes its deadline and external cancellation listener", async (t) => {
  const service = new AccountUsageService(() => CONFIG);
  const caller = new AbortController();
  let requestSignal: AbortSignal | null | undefined;
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const snapshot = await service.refresh({
    today: TODAY,
    signal: caller.signal,
    fetchImpl: async (_input, init) => {
      requestSignal = init?.signal;
      return new Response(JSON.stringify(reportPayload()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  assert.equal(service.snapshot, snapshot);
  assert.equal(service.loading, false);
  assert.equal(requestSignal?.aborted, false);

  caller.abort();
  t.mock.timers.tick(30_000);
  assert.equal(requestSignal?.aborted, false);
  assert.equal(service.lastError, undefined);
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
      // oxlint-disable-next-line eslint/no-await-in-loop
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

test("accountModelRows sorts by tokens and reports each model's share of plan credits", () => {
  const report = reportWith(
    [
      { model: "gemma4", totalTokens: 456 },
      { model: "glm5.3", totalTokens: 123, credits: 154 },
      { model: "deepseek-v4-flash", totalTokens: 150_000_000, credits: 1_000 },
      { model: "kimi-k3.1-pro", totalTokens: 1_100_000_000, credits: 5_000 },
    ],
    { allowance: 20_000, used: 6_154, remaining: 13_846, period_end: "2026-12-01" },
  );
  const rows = accountModelRows(report);
  assert.deepEqual(
    rows.map((row) => row.model),
    ["kimi-k3.1-pro", "deepseek-v4-flash", "gemma4", "glm5.3"],
  );
  assert.equal(rows[0].credits, 5_000);
  assert.equal(rows[0].percent, 25);
  assert.equal(rows[1].percent, 5);
  assert.equal(rows[2].percent, undefined);
  assert.equal(rows[2].note, "Does not draw credits");
  assert.equal(rows[3].credits, 154);
  assert.equal(rows[3].percent, 0.8);
});

test("accountModelRows does not invent a percentage without plan credits", () => {
  const rows = accountModelRows(reportWith([{ model: "deepseek-v4-flash", totalTokens: 5, credits: 3 }]));
  assert.equal(rows[0].percent, undefined);
  assert.equal(rows[0].note, undefined);
  assert.equal(rows[0].credits, 3);
});

test("accountModelRows passes reported cached input tokens through and leaves them unset when absent", () => {
  const rows = accountModelRows(
    reportWith([
      { model: "gemma4", totalTokens: 900, cachedTokens: 300 },
      { model: "deepseek-v4-flash", totalTokens: 12, credits: 1 },
    ]),
  );
  assert.deepEqual(
    rows.map((row) => [row.model, row.cachedTokens]),
    [
      ["gemma4", 300],
      ["deepseek-v4-flash", undefined],
    ],
  );
});

test("windowCredits sums per-model credits without float drift", () => {
  const report = reportWith([
    { model: "deepseek-v4-flash", totalTokens: 10, credits: 0.1 },
    { model: "kimi-k3.1-pro", totalTokens: 10, credits: 0.2 },
    { model: "hy4", totalTokens: 10, credits: 6_154.3 },
  ]);
  assert.equal(windowCredits(report), 6_154.6);
});

test("windowCredits stays undefined when no model billed credits", () => {
  assert.equal(windowCredits(reportWith([{ model: "gemma4", totalTokens: 10 }])), undefined);
  assert.equal(windowCredits(reportWith([{ model: "gemma4", totalTokens: 10, credits: 0 }])), undefined);
});

test("accountHeadline reports plan-credit usage and never fabricates one", () => {
  const headline = accountHeadline(
    reportWith([{ model: "kimi-k3.1-pro", totalTokens: 10, credits: 5_000 }], {
      allowance: 20_000,
      used: 21_000,
    }),
  );
  assert.deepEqual(headline, { model: "credits", percent: 105 });

  assert.equal(accountHeadline(reportWith([{ model: "gemma4", totalTokens: 10 }])), undefined);
  assert.equal(
    accountHeadline(reportWith([{ model: "gemma4", totalTokens: 10 }], { allowance: 0, used: 0 })),
    undefined,
  );
});
