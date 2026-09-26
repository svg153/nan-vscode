import { knownChatModelIds, toDisplayMetadata } from "./modelCatalog";

export interface ModelQuotaLimit {
  readonly tokens: number;
  readonly period: "month" | "billing period";
  readonly rollingTokens?: number;
  readonly rollingHours?: number;
}

const MODEL_QUOTA_LIMITS: Readonly<Record<string, ModelQuotaLimit>> = {
  "deepseek-v4-flash": { tokens: 3_000_000_000, period: "month" },
  "glm5.3-flash": { tokens: 2_000_000_000, period: "month" },
  "qwen3.8-flash": { tokens: 500_000_000, period: "month" },
  "mimo-v2.5": { tokens: 1_000_000_000, period: "month" },
  "mimo-v2.6-flash": { tokens: 1_000_000_000, period: "month" },
  "glm5.3": { tokens: 3_000_000_000, period: "billing period", rollingTokens: 400_000_000, rollingHours: 4 },
};

/** Models where NaN Builders documents no fixed token-counter allowance; never show a fabricated % for them. */
export const NO_TOKEN_COUNTER_MODELS: ReadonlySet<string> = new Set(["qwen3.6", "gemma4"]);

export interface QuotaSummaryItem {
  readonly label: string;
  readonly description: string;
  readonly detail: string;
}

/** Describes a quota that is NOT a fixed monthly counter (billing period / rolling window), or undefined. */
export function nonMonthlyQuotaNote(modelId: string): string | undefined {
  const limit = MODEL_QUOTA_LIMITS[modelId];
  if (!limit || limit.period === "month") {
    return undefined;
  }
  return `${compactTokens(limit.tokens)} per ${limit.period}` +
    `${limit.rollingTokens ? ` · ${compactTokens(limit.rollingTokens)} per rolling ${limit.rollingHours}h` : ""} (not a fixed monthly counter)`;
}

export function quotaSummaryItems(localUsage: ReadonlyMap<string, { requests: number; tokens: number }>): QuotaSummaryItem[] {
  const modelIds = new Set([...knownChatModelIds(), ...localUsage.keys()]);
  return [...modelIds].sort().map((modelId) => {
    const limit = MODEL_QUOTA_LIMITS[modelId];
    const local = localUsage.get(modelId) ?? { requests: 0, tokens: 0 };
    const cap = limit
      ? `${compactTokens(limit.tokens)} per ${limit.period}` +
        `${limit.rollingTokens ? ` · ${compactTokens(limit.rollingTokens)} per rolling ${limit.rollingHours}h` : ""}`
      : NO_TOKEN_COUNTER_MODELS.has(modelId)
        ? "No token counter"
        : "No published quota limit";

    return {
      label: toDisplayMetadata(modelId).name,
      description: `${cap} · local usage: ${compactTokens(local.tokens)}`,
      detail: local.requests
        ? `${local.requests} request(s) observed by this VS Code extension this session; not account-wide usage or remaining quota.`
        : "No requests observed by this VS Code extension this session.",
    };
  });
}

export interface QuotaUsageEntry {
  readonly model: string;
  /** total_tokens for the account usage window (totals.by_model from GET /v1/usage). */
  readonly totalTokens: number;
}

export interface QuotaUsageProgress {
  readonly model: string;
  /** used / published monthly quota, in percent with one decimal. */
  readonly percent: number;
  readonly usedTokens: number;
  readonly limitTokens: number;
}

/**
 * Compute usage percentages ONLY for models with a documented fixed monthly token
 * counter (deepseek-v4-flash, glm5.3-flash, qwen3.8-flash, mimo-v2.5, mimo-v2.6-flash).
 * glm5.3 (billing period / rolling 4h) and models without a published allowance are
 * excluded so the UI never fabricates a percentage the API does not define.
 * Sorted descending: the first entry is the most-restricted quota (status-bar headline).
 */
export function monthlyQuotaProgress(entries: readonly QuotaUsageEntry[]): QuotaUsageProgress[] {
  const progress: QuotaUsageProgress[] = [];
  for (const entry of entries) {
    const limit = MODEL_QUOTA_LIMITS[entry.model];
    if (!limit || limit.period !== "month") {
      continue;
    }
    progress.push({
      model: entry.model,
      percent: Math.round((entry.totalTokens / limit.tokens) * 1000) / 10,
      usedTokens: entry.totalTokens,
      limitTokens: limit.tokens,
    });
  }
  return progress.sort((a, b) => b.percent - a.percent);
}

export function compactTokens(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B tokens`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M tokens`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K tokens`;
  return `${value} tokens`;
}
