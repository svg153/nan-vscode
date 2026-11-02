import { accountModelRows, type AccountUsageError, type AccountUsageSnapshot } from "./accountUsage";
import type { QuotaSummaryItem } from "./quotaCatalog";
import { sanitizeUpstreamText } from "./text";
import { API_REQUESTS_CUTOFF_DATE } from "./usageApi";
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

export function escapeMarkdown(text: string): string {
  return sanitizeUpstreamText(text, Number.MAX_SAFE_INTEGER).replace(/([\\`*_[\]()])/g, "\\$1");
}

/**
 * Status-bar label: the most-restricted account-wide quota percentage when a
 * snapshot exists, otherwise the compact local session total, otherwise the
 * documented initial state.
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
    for (const row of accountModelRows(report)) {
      const suffix =
        row.percent !== undefined
          ? ` · **${formatPercent(row.percent)}%** of monthly quota`
          : row.note
            ? ` · ${row.note}`
            : "";
      lines.push(`- ${escapeMarkdown(row.model)}: ${row.totalTokens.toLocaleString()} tokens${suffix}\n`);
    }
    lines.push(`- Daily API-request counts are reported from ${API_REQUESTS_CUTOFF_DATE} onward; earlier days count 0.\n`);
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
