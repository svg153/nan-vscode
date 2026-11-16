import { accountModelRows, type AccountUsageError, type AccountUsageSnapshot } from "./accountUsage";
import type { QuotaSummaryItem } from "./quotaCatalog";
import { sanitizeUpstreamText } from "./text";
import {
  API_REQUESTS_CUTOFF_DATE,
  CACHED_TOKENS_CUTOFF_DATE,
  CREDITS_CUTOFF_DATE,
  type UsageCredits,
} from "./usageApi";
import type { DailyUsage } from "./usageHistory";

export interface TooltipInput {
  readonly snapshot?: AccountUsageSnapshot;
  readonly error?: AccountUsageError;
  readonly requests: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly lastModel?: string;
  readonly quotaItems: readonly QuotaSummaryItem[];
  readonly history: readonly DailyUsage[];
}

export function compact(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  }
  return String(value);
}

export function formatPercent(value: number): string {
  return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1);
}

/** Credits are billed with one decimal, so keep that precision without trailing zeros. */
export function formatCredits(value: number): string {
  const rounded = Number.isInteger(value) ? String(value) : value.toFixed(1);
  const [whole, fraction] = rounded.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction ? `${grouped}.${fraction}` : grouped;
}

/**
 * Plan credits for the current billing period. The field is additive and only
 * present on credit-billed accounts, so it yields no lines when absent.
 */
function creditsLines(credits: UsageCredits | undefined): string[] {
  if (!credits) {
    return [];
  }
  const parts: string[] = [];
  if (credits.allowance !== undefined) {
    parts.push(`allowance ${formatCredits(credits.allowance)}`);
  }
  if (credits.used !== undefined) {
    parts.push(`used ${formatCredits(credits.used)}`);
  }
  if (credits.remaining !== undefined) {
    parts.push(`remaining **${formatCredits(credits.remaining)}**`);
  }
  if (!parts.length) {
    return [];
  }
  const renews = credits.periodEnd ? ` · renews ${escapeMarkdown(credits.periodEnd)}` : "";
  const lines = [`- Plan credits: ${parts.join(" · ")}${renews}\n`];
  if (credits.packCredits) {
    const expires = credits.packExpiresAt ? ` until ${escapeMarkdown(credits.packExpiresAt)}` : "";
    lines.push(`- Credit pack: ${formatCredits(credits.packCredits)}${expires}\n`);
  }
  return lines;
}

export function escapeMarkdown(text: string): string {
  return sanitizeUpstreamText(text, Number.MAX_SAFE_INTEGER).replace(/([\\`*_[\]()])/g, "\\$1");
}

/**
 * Status-bar label: the share of plan credits used this period when a snapshot
 * exists, otherwise the compact local session total, otherwise the documented
 * initial state.
 */
export function statusBarText(headlinePercent: number | undefined, localTotal: number): string {
  if (headlinePercent !== undefined) {
    return `$(graph) NaN ${formatPercent(headlinePercent)}%`;
  }
  return localTotal > 0 ? `$(graph) NaN ${compact(localTotal)}` : "$(sparkle) NaN";
}

export function buildTooltipMarkdown(input: TooltipInput): string {
  const lines: string[] = [];
  const { snapshot, error } = input;

  if (snapshot) {
    const report = snapshot.report;
    lines.push(`$(pulse) **Account usage** — ${snapshot.startDate} → ${snapshot.endDate}\n\n`);
    lines.push(
      `- Window totals: **${report.totals.totalTokens.toLocaleString()} tokens** ` +
        `(${report.totals.promptTokens.toLocaleString()} prompt + ${report.totals.completionTokens.toLocaleString()} completion)` +
        ` · ${report.totals.apiRequests.toLocaleString()} API requests\n`,
    );
    lines.push(
      `- All-time: ${report.allTime.totalTokens.toLocaleString()} tokens · ` +
        `${report.allTime.apiRequests.toLocaleString()} API requests (cached at ${escapeMarkdown(report.allTime.cachedAt)})\n`,
    );
    lines.push(...creditsLines(report.credits));
    for (const row of accountModelRows(report)) {
      const credits = row.credits !== undefined ? ` · ${formatCredits(row.credits)} credits` : "";
      const suffix =
        row.percent !== undefined
          ? `${credits} · **${formatPercent(row.percent)}%** of plan credits`
          : row.note
            ? `${credits} · ${escapeMarkdown(row.note)}`
            : credits;
      lines.push(`- ${escapeMarkdown(row.model)}: ${row.totalTokens.toLocaleString()} tokens${suffix}\n`);
    }
    lines.push(`- Daily API-request counts are reported from ${API_REQUESTS_CUTOFF_DATE} onward; earlier days count 0.\n`);
    lines.push(`- Credits are billed and reported from ${CREDITS_CUTOFF_DATE} onward; earlier days bill 0.\n`);
    lines.push(`- Cached input tokens are reported from ${CACHED_TOKENS_CUTOFF_DATE} onward.\n`);
    lines.push(`- Last refresh: ${snapshot.fetchedAt}\n`);
    if (error) {
      lines.push(
        `- $(warning) Last refresh failed: ${escapeMarkdown(error.message)}` +
          `${error.retryAfterSeconds !== undefined ? ` (retry after ${error.retryAfterSeconds}s)` : ""}\n`,
      );
    }
    lines.push("\n---\n\n");
  } else if (error) {
    lines.push(
      `$(warning) **Account usage unavailable**: ${escapeMarkdown(error.message)}` +
        `${error.retryAfterSeconds !== undefined ? ` (retry after ${error.retryAfterSeconds}s)` : ""}\n\n---\n\n`,
    );
  } else {
    lines.push("$(pulse) **Account usage**: not loaded yet.\n\n---\n\n");
  }

  lines.push("**Local session usage** (observed by this VS Code extension only)\n\n");
  const localTotal = input.promptTokens + input.completionTokens;
  lines.push(
    `- Requests: ${input.requests} · prompt ${input.promptTokens.toLocaleString()} + ` +
      `completion ${input.completionTokens.toLocaleString()} = ${localTotal.toLocaleString()} tokens\n`,
  );
  if (input.lastModel) {
    lines.push(`- Last model: ${escapeMarkdown(input.lastModel)}\n`);
  }
  for (const item of input.quotaItems) {
    lines.push(`- ${escapeMarkdown(item.label)}: ${escapeMarkdown(item.description)}\n`);
  }
  lines.push("\nLocal history (last 30 days):\n\n");
  for (const row of input.history.slice(0, 20)) {
    lines.push(
      `- ${row.date} · ${escapeMarkdown(row.modelId)} · ${row.requests} request(s) · ` +
        `prompt ${row.promptTokens.toLocaleString()} + completion ${row.completionTokens.toLocaleString()}\n`,
    );
  }
  if (input.history.length === 0) {
    lines.push("No local usage history yet.\n");
  }
  return lines.join("");
}
