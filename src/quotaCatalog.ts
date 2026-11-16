import { knownChatModelIds, toDisplayMetadata } from "./modelCatalog";

/**
 * Models NaN documents as "no counter": they do not draw credits, so no
 * percentage of the plan allowance can be computed for them.
 */
export const UNMETERED_MODELS: ReadonlySet<string> = new Set([
  "gemma4",
  "qwen3.6",
  "qwen3-embedding",
  "rerank",
  "kokoro",
  "whisper",
  "flux-2-klein",
  "qwen-image-2.1",
]);

export interface QuotaSummaryItem {
  readonly label: string;
  readonly description: string;
  readonly detail: string;
}

/** Note for a model that draws no credits, or undefined when it is metered. */
export function unmeteredNote(modelId: string): string | undefined {
  return UNMETERED_MODELS.has(modelId) ? "Does not draw credits" : undefined;
}

export function quotaSummaryItems(localUsage: ReadonlyMap<string, { requests: number; tokens: number }>): QuotaSummaryItem[] {
  const known = new Set(knownChatModelIds());
  const modelIds = new Set([...known, ...localUsage.keys()]);
  // oxlint-disable-next-line unicorn/no-array-sort
  return [...modelIds].sort().map((modelId: string) => {
    const local = localUsage.get(modelId) ?? { requests: 0, tokens: 0 };
    const cap =
      unmeteredNote(modelId) ??
      (known.has(modelId) ? "Paid from plan credits" : "Billed in credits; no documented allowance");

    return {
      label: toDisplayMetadata(modelId).name,
      description: `${cap} · local usage: ${compactTokens(local.tokens)}`,
      detail: local.requests
        ? `${local.requests} request(s) observed by this VS Code extension this session; not account-wide usage or your credit balance.`
        : "No requests observed by this VS Code extension this session.",
    };
  });
}

export interface CreditUsageEntry {
  readonly model: string;
  /** Credits billed on this model in the window (`credits` on GET /v1/usage). */
  readonly credits: number;
}

export interface CreditUsageProgress {
  readonly model: string;
  /** credits / plan allowance, in percent with one decimal. */
  readonly percent: number;
  readonly usedCredits: number;
  readonly allowance: number;
}

/** One-decimal percentage, the precision NaN reports for credits. */
export function percentOf(part: number, whole: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) {
    return 0;
  }
  return Math.round((part / whole) * 1000) / 10;
}

/**
 * Percentage of the plan's credit allowance used by each model.
 * NaN bills every metered model from one credits pool (7,000 on Inference,
 * 20,000 on Premium, then credit packs); models that draw no credits and models
 * without credits in the window are excluded so no percentage is fabricated.
 * Sorted descending: the first entry is the largest consumer.
 */
export function creditProgress(
  entries: readonly CreditUsageEntry[],
  allowance: number | undefined,
): CreditUsageProgress[] {
  if (allowance === undefined || !Number.isFinite(allowance) || allowance <= 0) {
    return [];
  }
  const progress: CreditUsageProgress[] = [];
  for (const entry of entries) {
    if (UNMETERED_MODELS.has(entry.model) || !Number.isFinite(entry.credits) || entry.credits <= 0) {
      continue;
    }
    progress.push({
      model: entry.model,
      percent: percentOf(entry.credits, allowance),
      usedCredits: entry.credits,
      allowance,
    });
  }
  // oxlint-disable-next-line unicorn/no-array-sort
  return progress.sort((a, b) => b.percent - a.percent);
}

export function compactTokens(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B tokens`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M tokens`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K tokens`;
  return `${value} tokens`;
}
