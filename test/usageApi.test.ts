import assert from "node:assert/strict";
import test from "node:test";
import {
  API_REQUESTS_CUTOFF_DATE,
  MAX_USAGE_WINDOW_DAYS,
  UsageApiError,
  UsageRateLimiter,
  clampUsageLimit,
  clampUsageWindow,
  fetchUsagePage,
  fetchUsageReport,
  parseRetryAfter,
} from "../src/usageApi";

const authScheme = "Bearer";
const BASE_URL = "https://api.nan.builders/v1/";

interface CapturedCall {
  readonly url: string;
  readonly headers: Headers;
}

function reportPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    object: "usage.report",
    start_date: "2026-09-01",
    end_date: "2026-09-18",
    data: [
      {
        date: "2026-09-17",
        model: "mimo-v2.6-flash",
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        api_requests: 3,
      },
    ],
    totals: {
      prompt_tokens: 120,
      completion_tokens: 60,
      total_tokens: 180,
      api_requests: 4,
      by_model: [
        {
          model: "mimo-v2.6-flash",
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150,
          api_requests: 3,
        },
      ],
    },
    all_time: {
      prompt_tokens: 1_000,
      completion_tokens: 500,
      total_tokens: 1_500,
      api_requests: 90,
      cached_at: "2026-09-18T06:00:00Z",
    },
    has_more: false,
    next_cursor: null,
    ...overrides,
  };
}

function json(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function capturingFetch(calls: CapturedCall[]): typeof fetch {
  return async (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers) });
    return json(reportPayload());
  };
}

test("requests GET /v1/usage with clamped window, clamped limit, and Bearer auth", async () => {
  const calls: CapturedCall[] = [];
  await fetchUsagePage({
    baseUrl: BASE_URL,
    apiKey: "nan_test_key",
    startDate: "2026-09-01",
    endDate: "2026-09-18",
    limit: 9_999,
    fetchImpl: capturingFetch(calls),
  });
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(`${url.origin}${url.pathname}`, "https://api.nan.builders/v1/usage");
  assert.equal(url.searchParams.get("start_date"), "2026-09-01");
  assert.equal(url.searchParams.get("end_date"), "2026-09-18");
  assert.equal(url.searchParams.get("limit"), "500");
  assert.equal(calls[0].headers.get("Authorization"), `${authScheme} nan_test_key`);
});

test("parses a valid usage report into camelCase", async () => {
  const report = await fetchUsagePage({
    baseUrl: BASE_URL,
    apiKey: "k",
    fetchImpl: async () => json(reportPayload()),
  });
  assert.equal(report.object, "usage.report");
  assert.equal(report.startDate, "2026-09-01");
  assert.equal(report.endDate, "2026-09-18");
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].totalTokens, 150);
  assert.equal(report.totals.totalTokens, 180);
  assert.equal(report.totals.byModel[0].model, "mimo-v2.6-flash");
  assert.equal(report.allTime.cachedAt, "2026-09-18T06:00:00Z");
  assert.equal(report.hasMore, false);
  assert.equal(report.nextCursor, undefined);
});

test("rejects a usage page that advertises more rows without a cursor", async () => {
  await assert.rejects(
    fetchUsagePage({
      baseUrl: BASE_URL,
      apiKey: "k",
      fetchImpl: async () => json(reportPayload({ has_more: true, next_cursor: null })),
    }),
    (error: unknown) => error instanceof UsageApiError && error.kind === "malformed",
  );
});

test("merges rows across pages and keeps first-page full-window totals", async () => {
  const urls: string[] = [];
  let page = 0;
  const fetchImpl: typeof fetch = async (url) => {
    urls.push(String(url));
    page += 1;
    if (page === 1) {
      return json(reportPayload({ has_more: true, next_cursor: "cur_2" }));
    }
    return json(
      reportPayload({
        data: [
          {
            date: "2026-09-18",
            model: "deepseek-v4-flash",
            prompt_tokens: 7,
            completion_tokens: 3,
            total_tokens: 10,
            api_requests: 1,
          },
        ],
        totals: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, api_requests: 1, by_model: [] },
        has_more: false,
        next_cursor: null,
      }),
    );
  };
  const report = await fetchUsageReport({ baseUrl: BASE_URL, apiKey: "k", fetchImpl });
  assert.equal(urls.length, 2);
  assert.match(urls[1], /cursor=cur_2/);
  assert.equal(report.rows.length, 2);
  assert.equal(report.totals.totalTokens, 180);
  assert.equal(report.hasMore, false);
  assert.equal(report.nextCursor, undefined);
});

test("stops at maxPages and reports hasMore when pages remain", async () => {
  let page = 0;
  const fetchImpl: typeof fetch = async () => {
    page += 1;
    return json(reportPayload({ has_more: true, next_cursor: `cur_${page + 1}` }));
  };
  const report = await fetchUsageReport({ baseUrl: BASE_URL, apiKey: "k", maxPages: 2, fetchImpl });
  assert.equal(page, 2);
  assert.equal(report.hasMore, true);
  assert.equal(report.nextCursor, "cur_3");
});

test("follows the cursor when the first page is empty but more pages are advertised", async () => {
  let page = 0;
  const fetchImpl: typeof fetch = async () => {
    page += 1;
    if (page === 1) {
      return json(reportPayload({ data: [], has_more: true, next_cursor: "cur_2" }));
    }
    return json(reportPayload({ has_more: false, next_cursor: null }));
  };
  const report = await fetchUsageReport({ baseUrl: BASE_URL, apiKey: "k", fetchImpl });
  assert.equal(page, 2);
  assert.equal(report.object, "usage.report");
  assert.equal(report.rows.length, 1);
  assert.equal(report.totals.totalTokens, 180);
  assert.equal(report.hasMore, false);
  assert.equal(report.nextCursor, undefined);
});

test("continues after an empty intermediate page while the API advertises more rows", async () => {
  let page = 0;
  const fetchImpl: typeof fetch = async () => {
    page += 1;
    if (page === 1) {
      return json(reportPayload({ has_more: true, next_cursor: "cur_2" }));
    }
    if (page === 2) {
      return json(reportPayload({ data: [], has_more: true, next_cursor: "cur_3" }));
    }
    return json(reportPayload({ has_more: false, next_cursor: null }));
  };
  const report = await fetchUsageReport({ baseUrl: BASE_URL, apiKey: "k", fetchImpl });
  assert.equal(page, 3);
  assert.equal(report.rows.length, 2);
  assert.equal(report.hasMore, false);
  assert.equal(report.nextCursor, undefined);
});

test("clamps a too-wide window to the most recent 90 inclusive days, never past today", () => {
  const clamped = clampUsageWindow("2026-01-01", "2026-12-31", "2026-09-18");
  assert.deepEqual(clamped, { startDate: "2026-06-21", endDate: "2026-09-18" });

  const inRange = clampUsageWindow("2026-09-01", "2026-09-18", "2026-09-18");
  assert.deepEqual(inRange, { startDate: "2026-09-01", endDate: "2026-09-18" });

  const inverted = clampUsageWindow("2026-09-20", "2026-09-18", "2026-09-18");
  assert.deepEqual(inverted, { startDate: "2026-09-18", endDate: "2026-09-18" });

  const wide = clampUsageWindow("2026-01-01", "2026-12-31", "2026-12-31");
  const days =
    Math.round((Date.parse(`${wide.endDate}T00:00:00Z`) - Date.parse(`${wide.startDate}T00:00:00Z`)) / 86_400_000) + 1;
  assert.equal(days, MAX_USAGE_WINDOW_DAYS);
});

test("clamps limit to 1..500 with a 100 default", () => {
  assert.equal(clampUsageLimit(undefined), 100);
  assert.equal(clampUsageLimit(Number.NaN), 100);
  assert.equal(clampUsageLimit(0), 1);
  assert.equal(clampUsageLimit(-5), 1);
  assert.equal(clampUsageLimit(3.7), 3);
  assert.equal(clampUsageLimit(9_999), 500);
});

test("maps 401 to unauthorized", async () => {
  await assert.rejects(
    fetchUsagePage({
      baseUrl: BASE_URL,
      apiKey: "bad",
      fetchImpl: async () => json({ error: { message: "invalid key" } }, { status: 401 }),
    }),
    (error: unknown) =>
      error instanceof UsageApiError && error.kind === "unauthorized" && error.status === 401,
  );
});

test("does not send usage requests when endpoint authorization is canceled", async () => {
  let fetchCalls = 0;
  const abortError = new Error("User canceled endpoint confirmation.");
  abortError.name = "AbortError";

  await assert.rejects(
    fetchUsagePage({
      baseUrl: "http://api.example.test/v1",
      apiKey: "test-key",
      endpointAuthorizer: {
        authorize: async () => {
          throw abortError;
        },
      },
      fetchImpl: (async () => {
        fetchCalls += 1;
        return json({}, { status: 200 });
      }) as typeof fetch,
    }),
    (error: unknown) => error === abortError,
  );
  assert.equal(fetchCalls, 0);
});

test("usage request stays bound to the endpoint captured before authorization", async () => {
  const options = { baseUrl: "http://confirmed.example.test/v1", apiKey: "test-key" };
  let releaseAuthorization!: () => void;
  let authorizedBaseUrl = "";
  let requestedUrl = "";
  const authorizationPending = new Promise<void>((resolve) => {
    releaseAuthorization = resolve;
  });
  const requestOptions = {
    ...options,
    endpointAuthorizer: {
      authorize: async (baseUrl: string) => {
        authorizedBaseUrl = baseUrl;
        await authorizationPending;
      },
    },
    fetchImpl: async (url: RequestInfo | URL) => {
      requestedUrl = String(url);
      return json(reportPayload());
    },
  };
  const request = fetchUsagePage(requestOptions);

  requestOptions.baseUrl = "http://changed.example.test/v1";
  releaseAuthorization();
  await request;
  assert.equal(authorizedBaseUrl, "http://confirmed.example.test/v1");
  assert.equal(requestedUrl, "http://confirmed.example.test/v1/usage");
});

test("maps 429 to rate_limited with Retry-After seconds", async () => {
  await assert.rejects(
    fetchUsagePage({
      baseUrl: BASE_URL,
      apiKey: "k",
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: { message: "slow down" } }), {
          status: 429,
          headers: { "Retry-After": "12", "Content-Type": "application/json" },
        }),
    }),
    (error: unknown) =>
      error instanceof UsageApiError &&
      error.kind === "rate_limited" &&
      error.retryAfterSeconds === 12,
  );
});

test("parses Retry-After HTTP dates using the supplied reference time", () => {
  const now = Date.parse("2026-11-02T18:00:00.000Z");
  assert.equal(parseRetryAfter("Mon, 02 Nov 2026 18:00:12 GMT", now), 12);
  assert.equal(parseRetryAfter("Mon, 02 Nov 2026 17:59:59 GMT", now), undefined);
  assert.equal(parseRetryAfter("not a date", now), undefined);
  assert.equal(parseRetryAfter("-1", now), undefined);
});

test("maps 400 to bad_request carrying the server message", async () => {
  await assert.rejects(
    fetchUsagePage({
      baseUrl: BASE_URL,
      apiKey: "k",
      fetchImpl: async () => json({ error: { message: "window too wide" } }, { status: 400 }),
    }),
    (error: unknown) =>
      error instanceof UsageApiError &&
      error.kind === "bad_request" &&
      error.message.includes("window too wide"),
  );
});

test("redacts credentials and control characters from upstream error text", async () => {
  const body = JSON.stringify({ error: { message: "Invalid Bearer abcdef123456\r\nrequest" } });
  await assert.rejects(
    fetchUsagePage({
      baseUrl: BASE_URL,
      apiKey: "k",
      fetchImpl: async () => new Response(body, { status: 400, statusText: "Bad Request" }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof UsageApiError);
      assert.equal(error.message, "Invalid ****** request");
      assert.equal(error.message.includes("abcdef123456"), false);
      assert.equal(error.message.includes("\r"), false);
      return true;
    },
  );
});

test("redacts and bounds status text from server failures", async () => {
  await assert.rejects(
    fetchUsagePage({
      baseUrl: BASE_URL,
      apiKey: "k",
      fetchImpl: async () =>
        new Response("", { status: 503, statusText: `Bearer abcdef123456 ${"x".repeat(300)}\r\nInjected` }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof UsageApiError);
      assert.equal(error.message.includes("abcdef123456"), false);
      assert.equal(error.message.includes("Injected"), false);
      assert.equal(error.message.length < 250, true);
      return true;
    },
  );
});

test("rejects non-JSON and structurally malformed bodies as malformed", async () => {
  await assert.rejects(
    fetchUsagePage({ baseUrl: BASE_URL, apiKey: "k", fetchImpl: async () => new Response("<html>", { status: 200 }) }),
    (error: unknown) => error instanceof UsageApiError && error.kind === "malformed",
  );
  await assert.rejects(
    fetchUsagePage({
      baseUrl: BASE_URL,
      apiKey: "k",
      fetchImpl: async () => json(reportPayload({ object: "wrong.kind" })),
    }),
    (error: unknown) => error instanceof UsageApiError && error.kind === "malformed",
  );
  await assert.rejects(
    fetchUsagePage({
      baseUrl: BASE_URL,
      apiKey: "k",
      fetchImpl: async () => json(reportPayload({ totals: { prompt_tokens: -1 } })),
    }),
    (error: unknown) => error instanceof UsageApiError && error.kind === "malformed",
  );
});

test("rethrows cancellation AbortError untouched", async () => {
  const abortError = new Error("The operation was aborted.");
  abortError.name = "AbortError";
  const fetchImpl: typeof fetch = async () => {
    throw abortError;
  };
  await assert.rejects(
    fetchUsagePage({ baseUrl: BASE_URL, apiKey: "k", fetchImpl }),
    (error: unknown) => error === abortError && error instanceof Error && error.name === "AbortError",
  );
});

test("wraps fetch failures as network errors", async () => {
  const fetchImpl: typeof fetch = async () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(
    fetchUsagePage({ baseUrl: BASE_URL, apiKey: "k", fetchImpl }),
    (error: unknown) => error instanceof UsageApiError && error.kind === "network",
  );
});

test("UsageRateLimiter allows 30 requests per minute then blocks with Retry-After", () => {
  let now = 1_000_000;
  const limiter = new UsageRateLimiter(30, 60_000, () => now);
  for (let i = 0; i < 30; i += 1) {
    limiter.consume();
  }
  assert.throws(
    () => limiter.consume(),
    (error: unknown) =>
      error instanceof UsageApiError &&
      error.kind === "rate_limited" &&
      (error.retryAfterSeconds ?? 0) >= 1,
  );
  now += 60_000;
  assert.doesNotThrow(() => limiter.consume());
});

test("daily api_requests counts have a documented cutoff date", () => {
  assert.equal(API_REQUESTS_CUTOFF_DATE, "2026-09-02");
});
