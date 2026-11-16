// Pure NaN credit math + published metadata, mirrored from src/quotaCatalog.ts and
// src/modelCatalog.ts so the Copilot app plugin and the VS Code extension never
// fabricate a percentage the API does not define. Keep the tables in sync with TS.
//
// NaN bills every metered model from one credits pool (allowance per billing
// period) instead of fixed per-model monthly token counters, so a percentage is
// always the share of the plan allowance, never the share of a per-model cap.

/**
 * Models NaN documents as "no counter": they do not draw credits, so no
 * percentage of the plan allowance can be computed for them.
 */
export const UNMETERED_MODELS = new Set([
  "gemma4",
  "qwen3.6",
  "qwen3-embedding",
  "rerank",
  "kokoro",
  "whisper",
  "flux-2-klein",
  "qwen-image-2.1",
]);

export const KNOWN_CHAT_MODELS = [
  { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", contextWindow: 1_048_575, maxOutputTokens: 32_768, imageInput: true, toolCalling: true },
  { id: "glm5.3-flash", name: "GLM 5.3 Flash", contextWindow: 1_048_576, maxOutputTokens: 32_768, imageInput: true, toolCalling: true },
  { id: "qwen3.8-flash", name: "Qwen 3.8 Flash", contextWindow: 1_048_576, maxOutputTokens: 32_768, imageInput: true, toolCalling: false },
  { id: "mimo-v2.6-flash", name: "Xiaomi MiMo V2.6 Flash", contextWindow: 1_048_576, maxOutputTokens: 32_768, imageInput: true, toolCalling: true },
  { id: "gemma4", name: "Gemma 4", contextWindow: 262_144, maxOutputTokens: 65_536, imageInput: true, toolCalling: false },
  { id: "qwen3.6", name: "Qwen 3.6", contextWindow: 262_144, maxOutputTokens: 65_536, imageInput: true, toolCalling: false },
  { id: "glm5.3", name: "GLM 5.3", contextWindow: 1_048_576, maxOutputTokens: 32_768, imageInput: false, toolCalling: true, premium: true },
];

const BY_ID = new Map(KNOWN_CHAT_MODELS.map((model) => [model.id, model]));
const KNOWN_IDS = new Set(KNOWN_CHAT_MODELS.map((model) => model.id));

export function getKnownModel(id) {
  return BY_ID.get(id);
}

export function knownChatModelIds() {
  return KNOWN_CHAT_MODELS.map((model) => model.id);
}

/** Note for a model that draws no credits, or undefined when it is metered. */
export function unmeteredNote(modelId) {
  return UNMETERED_MODELS.has(modelId) ? "Does not draw credits" : undefined;
}

/** Published billing label for a model row; never a fabricated percentage. */
export function quotaCapLabel(modelId) {
  const unmetered = unmeteredNote(modelId);
  if (unmetered) {
    return unmetered;
  }
  return KNOWN_IDS.has(modelId) ? "Paid from plan credits" : "Billed in credits; no documented allowance";
}

/** One-decimal percentage, the precision NaN reports for credits. */
export function percentOf(part, whole) {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) {
    return 0;
  }
  return Math.round((part / whole) * 1000) / 10;
}

/** Credits are billed with one decimal, so any computed amount is re-rounded to that precision. */
export function roundCredits(value) {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : 0;
}

/**
 * Sums credit amounts to the billed precision. Per-model rows arrive rounded, so
 * adding them as floats drifts (0.1 + 0.2 = 0.30000000000000004) and would show
 * up as noise in totals.
 */
export function sumCredits(values) {
  return roundCredits(values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0));
}

/** Credits with the billed one-decimal precision, without a trailing `.0`. */
export function formatCredits(value) {
  const rounded = roundCredits(value);
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/**
 * Credits billed in the window's per-model rows. NaN rounds each model
 * independently, so this calendar-window sum is approximate: it can differ by
 * tenths from `credits.used`, which covers the billing period.
 */
export function windowCredits(entries) {
  const billed = entries
    .map((entry) => (Number.isFinite(entry?.credits) ? entry.credits : 0))
    .filter((value) => value > 0);
  return billed.length === 0 ? undefined : sumCredits(billed);
}

/**
 * Percentage of the plan's credit allowance used by each model.
 * NaN bills every metered model from one credits pool, so the share is always
 * measured against the plan allowance. Models that draw no credits and models
 * without credits in the window are excluded so no percentage is fabricated.
 * Sorted descending: the first entry is the largest consumer.
 */
export function creditProgress(entries, allowance) {
  if (!Number.isFinite(allowance) || allowance <= 0) {
    return [];
  }
  const progress = [];
  for (const entry of entries) {
    const credits = Number.isFinite(entry?.credits) ? entry.credits : 0;
    if (UNMETERED_MODELS.has(entry?.model) || credits <= 0) {
      continue;
    }
    progress.push({
      model: entry.model,
      percent: percentOf(credits, allowance),
      usedCredits: credits,
      allowance,
    });
  }
  return progress.sort((a, b) => b.percent - a.percent);
}

/** Note for a per-model row that shows no percentage; undefined when a % applies. */
export function creditsNote(modelId, credits) {
  const unmetered = unmeteredNote(modelId);
  if (unmetered) {
    return unmetered;
  }
  return !Number.isFinite(credits) || credits <= 0 ? "No credits billed in this window" : undefined;
}

/**
 * Plan credits for the billing period (`credits` on GET /v1/usage), or null when
 * the gateway predates the credits model. Percentages are suppressed while the
 * pool is frozen: credit-billed requests are being refused, so the share of
 * allowance is no longer the actionable number.
 */
export function creditsView(credits) {
  if (!credits) {
    return null;
  }
  const allowance = Number.isFinite(credits.allowance) ? credits.allowance : undefined;
  const used = Number.isFinite(credits.used) ? credits.used : undefined;
  const frozen = credits.frozen === true;
  return {
    allowance: allowance ?? null,
    used: used ?? null,
    remaining: Number.isFinite(credits.remaining) ? credits.remaining : null,
    packCredits: Number.isFinite(credits.packCredits) ? credits.packCredits : null,
    packExpiresAt: credits.packExpiresAt ?? null,
    periodStart: credits.periodStart ?? null,
    periodEnd: credits.periodEnd ?? null,
    frozen,
    percent: frozen || used === undefined || allowance === undefined || allowance <= 0 ? null : percentOf(used, allowance),
  };
}

/**
 * Usage payload shared by the canvas Usage tab and the nan_usage tool: the plan
 * credits headline plus one row per model the API reports. Every returned model
 * is rendered (no local allow-list), and a row only carries a percentage when
 * NaN billed it credits against a known, non-frozen allowance.
 */
export function composeUsage(report) {
  const credits = creditsView(report.credits);
  const percentByModel = new Map(
    creditProgress(
      report.totals.byModel.map((entry) => ({ model: entry.model, credits: entry.credits ?? 0 })),
      report.credits?.allowance,
    ).map((entry) => [entry.model, entry.percent]),
  );
  const items = report.totals.byModel
    .slice()
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .map((entry) => {
      const percent = !credits?.frozen && percentByModel.has(entry.model) ? percentByModel.get(entry.model) : null;
      return {
        model: entry.model,
        usedTokens: entry.totalTokens,
        requests: entry.apiRequests,
        credits: Number.isFinite(entry.credits) ? entry.credits : null,
        percent,
        note: percent === null ? creditsNote(entry.model, entry.credits) : undefined,
        cap: quotaCapLabel(entry.model),
      };
    });
  return {
    startDate: report.startDate,
    endDate: report.endDate,
    truncated: report.truncated,
    credits,
    windowCredits: windowCredits(report.totals.byModel) ?? null,
    totals: report.totals,
    items,
  };
}

export function compactTokens(value) {
  if (value >= 1_000_000_000) return (value / 1_000_000_000).toFixed(1) + "B tokens";
  if (value >= 1_000_000) return (value / 1_000_000).toFixed(1) + "M tokens";
  if (value >= 1_000) return (value / 1_000).toFixed(1) + "K tokens";
  return value + " tokens";
}
