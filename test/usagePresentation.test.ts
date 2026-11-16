import assert from "node:assert/strict";
import test from "node:test";
import type { AccountUsageSnapshot } from "../src/accountUsage";
import type { QuotaSummaryItem } from "../src/quotaCatalog";
import type { UsageReport } from "../src/usageApi";
import { normalizeHistory } from "../src/usageHistory";
import {
  buildTooltipMarkdown,
  compact,
  describePackExpiry,
  escapeMarkdown,
  formatCredits,
  formatPercent,
  statusBarText,
  usageLinks,
} from "../src/usagePresentation";

function report(overrides: Partial<UsageReport> = {}): UsageReport {
  return {
    object: "usage.report",
    startDate: "2026-01-01",
    endDate: "2026-01-31",
    rows: [],
    totals: {
      promptTokens: 1_000,
      completionTokens: 2_000,
      totalTokens: 3_000,
      apiRequests: 7,
      credits: 210,
      byModel: [
        {
          model: "deepseek-v4-flash",
          promptTokens: 1_000,
          completionTokens: 2_000,
          totalTokens: 3_000,
          apiRequests: 7,
          credits: 210,
        },
      ],
    },
    credits: {
      periodEnd: "2026-02-01",
      allowance: 7_000,
      used: 210,
      remaining: 6_790,
      packCredits: 1_000,
      packExpiresAt: "2026-06-01",
    },
    allTime: {
      promptTokens: 10_000,
      completionTokens: 20_000,
      totalTokens: 30_000,
      apiRequests: 40,
      cachedAt: "2026-01-31T00:00:00.000Z",
    },
    hasMore: false,
    ...overrides,
  };
}

function snapshot(overrides: Partial<UsageReport> = {}): AccountUsageSnapshot {
  return {
    startDate: "2026-01-01",
    endDate: "2026-01-31",
    fetchedAt: "2026-01-31T12:00:00.000Z",
    report: report(overrides),
  };
}

const quotaItems: readonly QuotaSummaryItem[] = [
  { label: "DeepSeek V4 Flash", description: "Paid from plan credits · local usage: 3K", detail: "1 request(s)" },
];

test("status bar shows the documented initial state for an empty history", () => {
  assert.equal(statusBarText(undefined, 0), "$(sparkle) NaN");
});

test("status bar shows the compact local total when no account snapshot exists", () => {
  assert.equal(statusBarText(undefined, 1_500), "$(graph) NaN 1.5K");
  assert.equal(statusBarText(undefined, 12_000), "$(graph) NaN 12K");
});

test("status bar prefers the plan-credit percentage when available", () => {
  assert.equal(statusBarText(42, 1_500), "$(graph) NaN 42%");
  assert.equal(statusBarText(42.5, 0), "$(graph) NaN 42.5%");
});

test("compact formats magnitudes with one decimal below ten units", () => {
  assert.equal(compact(0), "0");
  assert.equal(compact(999), "999");
  assert.equal(compact(1_000), "1.0K");
  assert.equal(compact(9_999), "10.0K");
  assert.equal(compact(10_000), "10K");
  assert.equal(compact(1_000_000), "1.0M");
  assert.equal(compact(10_000_000), "10M");
});

test("formatPercent keeps integers whole and decimals to one place", () => {
  assert.equal(formatPercent(0), "0");
  assert.equal(formatPercent(7), "7");
  assert.equal(formatPercent(7.25), "7.3");
});

test("escapeMarkdown escapes markdown punctuation and collapses newlines", () => {
  assert.equal(escapeMarkdown("a*b_c`d[e](f)"), "a\\*b\\_c\\`d\\[e\\]\\(f\\)");
  assert.equal(escapeMarkdown("line1\nline2"), "line1 line2");
});

test("formatCredits keeps whole credits compact and decimals to one place", () => {
  assert.equal(formatCredits(0), "0");
  assert.equal(formatCredits(7_000), "7,000");
  assert.equal(formatCredits(210), "210");
  assert.equal(formatCredits(0.4), "0.4");
});

test("describePackExpiry turns pack_expires_at into a readable date with day distance", () => {
  const now = new Date("2026-05-20T10:30:00.000Z");
  assert.equal(describePackExpiry("2026-06-01", now), "expires 2026-06-01 (in 12 days)");
  assert.equal(describePackExpiry("2026-05-21", now), "expires tomorrow (2026-05-21)");
  assert.equal(describePackExpiry("2026-05-20", now), "expires today (2026-05-20)");
  assert.equal(describePackExpiry("2026-05-19", now), "expired on 2026-05-19");
});

test("describePackExpiry accepts ISO timestamps and passes through unparsable values", () => {
  const now = new Date("2026-05-20T10:30:00.000Z");
  assert.equal(describePackExpiry("2026-06-01T00:00:00.000Z", now), "expires 2026-06-01 (in 12 days)");
  assert.equal(describePackExpiry("next billing cycle", now), "next billing cycle");
  assert.equal(describePackExpiry("", now), "");
});

test("usageLinks points at the API-keys deep link and the model catalogue", () => {
  const links = usageLinks();
  assert.deepEqual(
    links.map((link) => link.url),
    ["https://cloud.nan.builders/#settings-api-keys", "https://nan.builders/docs/models"],
  );
  assert.deepEqual(
    links.map((link) => link.label),
    ["Open API keys", "Open model docs"],
  );
});

test("tooltip includes the plan-credit percentage and the reporting period", () => {
  const md = buildTooltipMarkdown({
    snapshot: snapshot(),
    requests: 1,
    promptTokens: 1_000,
    completionTokens: 2_000,
    quotaItems,
    history: [],
  });
  assert.match(md, /Account usage\*\* — 2026-01-01 → 2026-01-31/);
  assert.match(md, /Plan credits: allowance 7,000 · used 210 · remaining \*\*6,790\*\* · renews 2026-02-01/);
  assert.match(md, /Credit pack: 1,000 credits · (expires|expired on) 2026-06-01/);
  assert.match(md, /Window credits: \*\*210\*\* — approximate calendar-month sum of the per-model rows/);
  assert.match(md, /deepseek-v4-flash: 3[.,]?000 tokens · 210 credits · \*\*3%\*\* of plan credits/);
  assert.match(md, /Window totals: \*\*3[.,]?000 tokens\*\*/);
  assert.match(md, /Credits are billed and reported from 2026-11-10 onward/);
  assert.match(md, /Cached input tokens are reported from 2026-11-11 onward/);
  assert.match(md, /Last refresh: 2026-01-31T12:00:00\.000Z/);
});

test("tooltip omits the credits block on accounts that are not billed in credits", () => {
  const md = buildTooltipMarkdown({
    snapshot: snapshot({ credits: undefined, totals: { promptTokens: 1, completionTokens: 0, totalTokens: 1, apiRequests: 1, byModel: [] } }),
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    quotaItems,
    history: [],
  });
  assert.doesNotMatch(md, /Plan credits:/);
  assert.doesNotMatch(md, /% of plan credits/);
});

test("tooltip shows reported cached input tokens for the window and each model", () => {
  const md = buildTooltipMarkdown({
    snapshot: snapshot({
      totals: {
        promptTokens: 1_000,
        cachedTokens: 400,
        completionTokens: 2_000,
        totalTokens: 3_000,
        apiRequests: 7,
        credits: 210,
        byModel: [
          {
            model: "deepseek-v4-flash",
            promptTokens: 1_000,
            cachedTokens: 400,
            completionTokens: 2_000,
            totalTokens: 3_000,
            apiRequests: 7,
            credits: 210,
          },
        ],
      },
    }),
    requests: 1,
    promptTokens: 1_000,
    completionTokens: 2_000,
    quotaItems,
    history: [],
  });
  assert.match(md, /Window totals: \*\*3[.,]?000 tokens\*\* \(1[.,]?000 prompt \+ 2[.,]?000 completion\), 400 of the prompt cached/);
  assert.match(md, /deepseek-v4-flash: 3[.,]?000 tokens · 400 cached · 210 credits/);
});

test("tooltip omits cached input tokens when NaN does not report them", () => {
  const md = buildTooltipMarkdown({
    snapshot: snapshot(),
    requests: 1,
    promptTokens: 1_000,
    completionTokens: 2_000,
    quotaItems,
    history: [],
  });
  assert.doesNotMatch(md, /of the prompt cached/);
  assert.doesNotMatch(md, / tokens · .* cached/);
  assert.doesNotMatch(md, /frozen/);
});

test("tooltip shows the credit period range and warns about frozen plan credits", () => {
  const md = buildTooltipMarkdown({
    snapshot: snapshot({
      credits: {
        periodStart: "2026-01-02",
        periodEnd: "2026-02-01",
        allowance: 7_000,
        used: 210,
        remaining: 6_790,
        frozen: true,
      },
    }),
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    quotaItems,
    history: [],
  });
  assert.match(md, /Plan credits: allowance 7,000 · used 210 · remaining \*\*6,790\*\* · 2026-01-02 → 2026-02-01/);
  assert.match(md, /Plan credits are frozen: credit-billed requests are refused/);
  assert.doesNotMatch(md, /renews 2026-02-01/);
});

test("tooltip reports a failed refresh alongside the retained snapshot", () => {
  const md = buildTooltipMarkdown({
    snapshot: snapshot(),
    error: { message: "rate limited", retryAfterSeconds: 30, at: "2026-01-31T12:01:00.000Z" },
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    quotaItems,
    history: [],
  });
  assert.match(md, /Last refresh failed: rate limited \(retry after 30s\)/);
});

test("tooltip explains an unavailable account usage when only an error exists", () => {
  const md = buildTooltipMarkdown({
    error: { message: "no api key", at: "2026-01-31T12:01:00.000Z" },
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    quotaItems,
    history: [],
  });
  assert.match(md, /Account usage unavailable\*\*: no api key/);
  assert.doesNotMatch(md, /retry after/);
});

test("tooltip states that account usage is not loaded yet", () => {
  const md = buildTooltipMarkdown({
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    quotaItems,
    history: [],
  });
  assert.match(md, /Account usage\*\*: not loaded yet/);
});

test("tooltip renders local session usage, quota items and history", () => {
  const md = buildTooltipMarkdown({
    requests: 3,
    promptTokens: 1_500,
    completionTokens: 500,
    lastModel: "deepseek-v4-flash",
    quotaItems,
    history: [{ date: "2026-01-31", modelId: "deepseek-v4-flash", requests: 3, promptTokens: 1_500, completionTokens: 500 }],
  });
  assert.match(md, /Requests: 3 · prompt 1[.,]?500 \+ completion 500 = 2[.,]?000 tokens/);
  assert.match(md, /Last model: deepseek-v4-flash/);
  assert.match(md, /DeepSeek V4 Flash: Paid from plan credits · local usage: 3K/);
  assert.match(md, /Local history \(last 30 days\):/);
  assert.match(md, /2026-01-31 · deepseek-v4-flash/);
});

test("tooltip escapes untrusted model identifiers without opening markdown links or code blocks", () => {
  const hostile = "model`\\n[phish](https://bad.example)```";
  const md = buildTooltipMarkdown({
    snapshot: snapshot({
      totals: {
        promptTokens: 1,
        completionTokens: 0,
        totalTokens: 1,
        apiRequests: 1,
        byModel: [{ model: hostile, promptTokens: 1, completionTokens: 0, totalTokens: 1, apiRequests: 1 }],
      },
    }),
    requests: 1,
    promptTokens: 1,
    completionTokens: 0,
    lastModel: hostile,
    quotaItems: [{ label: hostile, description: "usage", detail: "" }],
    history: [{ date: "2026-01-31", modelId: hostile, requests: 1, promptTokens: 1, completionTokens: 0 }],
  });
  assert.equal(md.includes("[phish]("), false);
  assert.equal(md.includes("```"), false);
  assert.equal(md.includes("model\\`"), true);
});

test("history loading keeps only valid stored records", () => {
  const today = "2026-01-31";
  const kept = normalizeHistory(
    [
      { date: today, modelId: "deepseek-v4-flash", requests: 2, promptTokens: 10, completionTokens: 5 },
      { date: today, modelId: "", requests: 1, promptTokens: 1, completionTokens: 1 },
      { date: "not-a-date", modelId: "glm5.3-flash", requests: 1, promptTokens: 1, completionTokens: 1 },
      { date: today, modelId: "glm5.3-flash", requests: -1, promptTokens: 1, completionTokens: 1 },
      "garbage",
      null,
    ],
    today,
  );
  assert.equal(kept.length, 1);
  assert.equal(kept[0].modelId, "deepseek-v4-flash");
});
