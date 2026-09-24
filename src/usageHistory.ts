import type { OpenAIUsage } from "./openai/types";

export interface DailyUsage {
  date: string;
  modelId: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
}

const RETENTION_DAYS = 30;
const MAX_ROWS = 1_000;

export function normalizeHistory(value: unknown, today = utcDate()): DailyUsage[] {
  if (!Array.isArray(value)) return [];
  const firstDate = new Date(Date.parse(`${today}T00:00:00Z`) - (RETENTION_DAYS - 1) * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return value
    .filter(isDailyUsage)
    .map((row) => ({ ...row }))
    .filter((row) => row.date >= firstDate && row.date <= today)
    .sort((a, b) => b.date.localeCompare(a.date) || a.modelId.localeCompare(b.modelId))
    .slice(0, MAX_ROWS);
}

export function addUsage(
  history: readonly DailyUsage[],
  modelId: string,
  usage: OpenAIUsage | undefined,
  today = utcDate(),
): DailyUsage[] {
  const records = normalizeHistory(history, today);
  const existing = records.find((row) => row.date === today && row.modelId === modelId);
  if (existing) {
    existing.requests = addCount(existing.requests, 1);
    existing.promptTokens = addCount(existing.promptTokens, tokenCount(usage?.prompt_tokens));
    existing.completionTokens = addCount(existing.completionTokens, tokenCount(usage?.completion_tokens));
  } else {
    records.push({
      date: today,
      modelId,
      requests: 1,
      promptTokens: tokenCount(usage?.prompt_tokens),
      completionTokens: tokenCount(usage?.completion_tokens),
    });
  }
  return normalizeHistory(records, today);
}

export function formatHistory(history: readonly DailyUsage[]): string {
  if (history.length === 0) return "No local usage history yet.";
  return history
    .map((row) => `${row.date} · ${row.modelId} · ${row.requests} request(s) · prompt ${row.promptTokens.toLocaleString()} + completion ${row.completionTokens.toLocaleString()}`)
    .join("\n");
}

function isDailyUsage(value: unknown): value is DailyUsage {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Partial<DailyUsage>;
  return typeof row.date === "string" && isUtcDate(row.date) &&
    typeof row.modelId === "string" && row.modelId.length > 0 && row.modelId.length <= 128 &&
    isCount(row.requests) && isCount(row.promptTokens) && isCount(row.completionTokens);
}

function isUtcDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function tokenCount(value: number | undefined): number {
  return isCount(value) ? value : 0;
}

function addCount(current: number, added: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, current + added);
}

function utcDate(): string {
  return new Date().toISOString().slice(0, 10);
}
