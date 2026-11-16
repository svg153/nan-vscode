// Pure NaN quota math + published metadata, mirrored from src/quotaCatalog.ts and
// src/modelCatalog.ts so the Copilot app plugin and the VS Code extension never
// fabricate a percentage the API does not define. Keep the tables in sync with TS.

export const MODEL_QUOTA_LIMITS = {
  "deepseek-v4-flash": { tokens: 3_000_000_000, period: "month" },
  "glm5.3-flash": { tokens: 2_000_000_000, period: "month" },
  "qwen3.8-flash": { tokens: 500_000_000, period: "month" },
  "mimo-v2.6-flash": { tokens: 1_000_000_000, period: "month" },
  "glm5.3": { tokens: 3_000_000_000, period: "billing period", rollingTokens: 400_000_000, rollingHours: 4 },
};

/** Models where NaN documents no fixed token-counter allowance; never show a % for them. */
export const NO_TOKEN_COUNTER_MODELS = new Set(["qwen3.6", "gemma4"]);

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

export function getKnownModel(id) {
  return BY_ID.get(id);
}

export function knownChatModelIds() {
  return KNOWN_CHAT_MODELS.map((model) => model.id);
}

function capLabel(limit) {
  return compactTokens(limit.tokens) + " per " + limit.period +
    (limit.rollingTokens ? " · " + compactTokens(limit.rollingTokens) + " per rolling " + limit.rollingHours + "h" : "");
}

/** Describes a quota that is NOT a fixed monthly counter, or undefined. */
export function nonMonthlyQuotaNote(modelId) {
  const limit = MODEL_QUOTA_LIMITS[modelId];
  if (!limit || limit.period === "month") {
    return undefined;
  }
  return capLabel(limit) + " (not a fixed monthly counter)";
}

/** Human cap label for the catalog/usage tables; never a fabricated percentage. */
export function quotaCapLabel(modelId) {
  const limit = MODEL_QUOTA_LIMITS[modelId];
  if (limit) {
    return capLabel(limit);
  }
  if (NO_TOKEN_COUNTER_MODELS.has(modelId)) {
    return "No token counter";
  }
  return "No published quota limit";
}

/**
 * Usage percentages ONLY for models with a documented fixed monthly counter.
 * Sorted descending: the first entry is the most-restricted quota (headline).
 * Entries: [{ model, totalTokens }] from GET /v1/usage totals.by_model.
 */
export function monthlyQuotaProgress(entries) {
  const progress = [];
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

export function compactTokens(value) {
  if (value >= 1_000_000_000) return (value / 1_000_000_000).toFixed(1) + "B tokens";
  if (value >= 1_000_000) return (value / 1_000_000).toFixed(1) + "M tokens";
  if (value >= 1_000) return (value / 1_000).toFixed(1) + "K tokens";
  return value + " tokens";
}
