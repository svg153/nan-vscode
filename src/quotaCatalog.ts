import { knownChatModelIds, toDisplayMetadata } from "./modelCatalog";

export interface ModelQuotaLimit {
  readonly billingPeriodTokens?: number;
  readonly rollingTokens?: number;
  readonly rollingHours?: number;
}

const MODEL_QUOTA_LIMITS: Readonly<Record<string, ModelQuotaLimit>> = {
  "deepseek-v4-flash": { billingPeriodTokens: 3_000_000_000 },
  "glm5.3-flash": { billingPeriodTokens: 2_000_000_000 },
  "qwen3.8-flash": { billingPeriodTokens: 500_000_000 },
  "mimo-v2.5": { billingPeriodTokens: 1_000_000_000 },
  "glm5.3": { billingPeriodTokens: 3_000_000_000, rollingTokens: 400_000_000, rollingHours: 4 },
};

export interface QuotaSummaryItem {
  readonly label: string;
  readonly description: string;
  readonly detail: string;
}

export function quotaSummaryItems(localUsage: ReadonlyMap<string, { requests: number; tokens: number }>): QuotaSummaryItem[] {
  const modelIds = new Set([...knownChatModelIds(), ...localUsage.keys()]);
  return [...modelIds].sort().map((modelId) => {
    const limit = MODEL_QUOTA_LIMITS[modelId];
    const local = localUsage.get(modelId) ?? { requests: 0, tokens: 0 };
    const cap = limit
      ? `${limit.billingPeriodTokens ? `${compactTokens(limit.billingPeriodTokens)} per billing period` : ""}` +
        `${limit.rollingTokens ? ` · ${compactTokens(limit.rollingTokens)} per rolling ${limit.rollingHours}h` : ""}`
      : "No published quota limit";

    return {
      label: toDisplayMetadata(modelId).name,
      description: `${cap} · local usage: ${compactTokens(local.tokens)}`,
      detail: local.requests
        ? `${local.requests} request(s) observed by this VS Code extension this session; not account-wide usage or remaining quota.`
        : "No requests observed by this VS Code extension this session. Account-wide usage and remaining quota are unavailable.",
    };
  });
}

function compactTokens(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B tokens`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M tokens`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K tokens`;
  return `${value} tokens`;
}
