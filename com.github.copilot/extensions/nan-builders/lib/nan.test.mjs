import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_BASE_URL,
  NanError,
  classifyBaseUrl,
  fetchUsage,
  isChatModel,
  monthUtcWindow,
  normalizeBaseUrl,
  redactSecret,
} from "./nan.mjs";

test("normalizeBaseUrl trims, strips trailing slashes and defaults", () => {
  assert.equal(normalizeBaseUrl("https://api.nan.builders/v1/"), "https://api.nan.builders/v1");
  assert.equal(normalizeBaseUrl("  "), DEFAULT_BASE_URL);
  assert.equal(normalizeBaseUrl(undefined), DEFAULT_BASE_URL);
});

test("classifyBaseUrl separates https, loopback http, remote http and garbage", () => {
  assert.equal(classifyBaseUrl("https://api.nan.builders/v1"), "https");
  assert.equal(classifyBaseUrl("http://127.0.0.1:8787/v1"), "http-loopback");
  assert.equal(classifyBaseUrl("http://localhost:3000/v1"), "http-loopback");
  assert.equal(classifyBaseUrl("http://example.com/v1"), "http-insecure");
  assert.equal(classifyBaseUrl("ftp://example.com"), "invalid");
  assert.equal(classifyBaseUrl("not a url"), "invalid");
});

test("monthUtcWindow is inclusive UTC current month", () => {
  const window = monthUtcWindow(new Date(Date.UTC(2026, 0, 15, 23, 59)));
  assert.deepEqual(window, { startDate: "2026-01-01", endDate: "2026-01-15" });
});

test("redactSecret removes every key occurrence from messages", () => {
  assert.equal(redactSecret("Bearer sk-abc and sk-abc again", "sk-abc"), "Bearer [redacted] and [redacted] again");
  assert.equal(redactSecret("nothing here", ""), "nothing here");
});

test("isChatModel follows metadata, denylist and known catalog (conservative default)", () => {
  assert.equal(isChatModel({ id: "whisper", is_chat: true }), false); // denylist wins
  assert.equal(isChatModel({ id: "mystery", is_chat: true }), true); // explicit metadata
  assert.equal(isChatModel({ id: "mystery", model_type: "embedding" }), false);
  assert.equal(isChatModel({ id: "qwen3.8-flash" }), true); // known catalog fallback
  assert.equal(isChatModel({ id: "qwen4-max" }), true); // known catalog fallback
  assert.equal(isChatModel({ id: "hy4-flash" }), true); // known catalog fallback
  assert.equal(isChatModel({ id: "mystery" }), false); // unknown without metadata
});

function jsonResponse(status, payload) {
  const text = JSON.stringify(payload);
  return { ok: status >= 200 && status < 300, status, body: undefined, text: async () => text };
}

test("fetchUsage merges cursor pages and normalizes totals", async () => {
  const original = globalThis.fetch;
  const urls = [];
  try {
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      if (String(url).includes("cursor=")) {
        return jsonResponse(200, {
          object: "usage.report",
          data: [{ date: "2026-01-02", model: "qwen3.8-flash", total_tokens: 20, prompt_tokens: 12, completion_tokens: 8, api_requests: 1 }],
          totals: { prompt_tokens: 32, completion_tokens: 20, total_tokens: 52, api_requests: 3, by_model: [{ model: "qwen3.8-flash", prompt_tokens: 32, completion_tokens: 20, total_tokens: 52, api_requests: 3 }] },
          has_more: false,
        });
      }
      return jsonResponse(200, {
        object: "usage.report",
        data: [{ date: "2026-01-01", model: "qwen3.8-flash", total_tokens: 32, prompt_tokens: 20, completion_tokens: 12, api_requests: 2 }],
        totals: { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32, api_requests: 2, by_model: [{ model: "qwen3.8-flash", prompt_tokens: 20, completion_tokens: 12, total_tokens: 32, api_requests: 2 }] },
        has_more: true,
        next_cursor: "cur1",
      });
    };
    const report = await fetchUsage({ baseUrl: DEFAULT_BASE_URL, apiKey: "sk-test" }, { startDate: "2026-01-01", endDate: "2026-01-31" });
    assert.equal(report.rows.length, 2);
    assert.equal(report.truncated, false);
    assert.equal(report.totals.totalTokens, 32); // first page totals object
    assert.equal(report.totals.byModel[0].model, "qwen3.8-flash");
    assert.ok(urls[0].includes("start_date=2026-01-01") && urls[0].includes("end_date=2026-01-31") && urls[0].includes("limit=500"));
    assert.ok(urls[1].includes("cursor=cur1"));
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchUsage parses the credits block into camelCase plan credits", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      const shared = {
        allowance: 7000.5,
        used: 1234.5,
        remaining: 5766,
        period_start: "2026-11-01",
        period_end: "2026-12-01",
        frozen: true,
      };
      const payload = String(url).includes("cursor=")
        ? { object: "usage.report", totals: { total_tokens: 0 }, credits: { ...shared, used: 999 }, has_more: false }
        : {
            object: "usage.report",
            data: [],
            totals: {
              prompt_tokens: 10,
              completion_tokens: 5,
              total_tokens: 15,
              api_requests: 1,
              credits: 4.5,
              by_model: [{ model: "glm5.3", prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, api_requests: 1, credits: 4.5 }],
            },
            credits: { ...shared, pack_credits: 500, pack_expires_at: "2027-01-01" },
            has_more: true,
            next_cursor: "cur1",
          };
      return jsonResponse(200, payload);
    };
    const report = await fetchUsage({ baseUrl: DEFAULT_BASE_URL, apiKey: "sk-test" }, { startDate: "2026-11-01", endDate: "2026-11-16" });
    assert.deepEqual(report.credits, {
      allowance: 7000.5,
      used: 1234.5,
      remaining: 5766,
      packCredits: 500,
      packExpiresAt: "2027-01-01",
      periodStart: "2026-11-01",
      periodEnd: "2026-12-01",
      frozen: true,
    });
    assert.equal(report.totals.credits, 4.5);
    assert.equal(report.totals.byModel[0].credits, 4.5);
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchUsage tolerates a gateway without the credits block", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      jsonResponse(200, {
        object: "usage.report",
        data: [],
        totals: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, api_requests: 0, by_model: [] },
        has_more: false,
      });
    const report = await fetchUsage({ baseUrl: DEFAULT_BASE_URL, apiKey: "sk-test" }, { startDate: "2026-11-01", endDate: "2026-11-16" });
    assert.equal(report.credits, undefined);
    assert.equal(report.totals.credits, undefined);
    assert.deepEqual(report.totals.byModel, []);
    assert.equal(report.truncated, false);
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchUsage keeps per-model credits optional and drops a malformed block", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      jsonResponse(200, {
        object: "usage.report",
        data: [],
        totals: {
          total_tokens: 30,
          by_model: [
            { model: "gemma4", total_tokens: 10 },
            { model: "unknown-model", total_tokens: 20, credits: "many" },
          ],
        },
        credits: "not-an-object",
        has_more: false,
      });
    const report = await fetchUsage({ baseUrl: DEFAULT_BASE_URL, apiKey: "sk-test" }, { startDate: "2026-11-01", endDate: "2026-11-16" });
    assert.equal(report.credits, undefined);
    assert.equal(report.totals.byModel[0].credits, undefined);
    assert.equal(report.totals.byModel[1].credits, undefined);
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchUsage drops a credits block with no recognisable field", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      jsonResponse(200, {
        object: "usage.report",
        data: [],
        totals: { total_tokens: 5, by_model: [] },
        credits: { allowance: "invalid", used: null },
        has_more: false,
      });
    const report = await fetchUsage({ baseUrl: DEFAULT_BASE_URL, apiKey: "sk-test" }, { startDate: "2026-11-01", endDate: "2026-11-16" });
    assert.equal(report.credits, undefined);
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchUsage keeps the valid fields of a partially malformed credits block", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      jsonResponse(200, {
        object: "usage.report",
        data: [],
        totals: { total_tokens: 5, by_model: [] },
        credits: { allowance: "invalid", used: null, remaining: 10, frozen: false },
        has_more: false,
      });
    const report = await fetchUsage({ baseUrl: DEFAULT_BASE_URL, apiKey: "sk-test" }, { startDate: "2026-11-01", endDate: "2026-11-16" });
    assert.deepEqual(report.credits, { remaining: 10, frozen: false });
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchUsage maps HTTP 429 to a rate_limited NanError with API message", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => jsonResponse(429, { error: { message: "slow down" } });
    await assert.rejects(
      fetchUsage({ baseUrl: DEFAULT_BASE_URL, apiKey: "sk-test" }),
      (error) => error instanceof NanError && error.kind === "rate_limited" && /slow down/.test(error.message) && error.status === 429,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchUsage refuses non-loopback plain HTTP before hitting the network", async () => {
  const original = globalThis.fetch;
  try {
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      return jsonResponse(200, {});
    };
    await assert.rejects(
      fetchUsage({ baseUrl: "http://example.com/v1", apiKey: "sk-test" }),
      (error) => error instanceof NanError && error.kind === "confirmation_required",
    );
    assert.equal(called, false);
  } finally {
    globalThis.fetch = original;
  }
});
