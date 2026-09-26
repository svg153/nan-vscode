// Client for NaN's documented account-wide usage endpoint: GET /v1/usage.
// Contract: helmcode/nan OpenAPI (operation getUsage).
// - Window may span at most 90 inclusive days; a wider window is rejected with 400
//   (never clamped server-side, so this client clamps before sending).
// - limit is 1..500 (server clamps out-of-range, non-numeric falls back to 100).
// - totals and totals.by_model cover the full requested window even when the page
//   is partial; rows are paged via next_cursor.
// - Rate limit: 30 requests per minute per member; a 429 carries Retry-After.

export const MAX_USAGE_WINDOW_DAYS = 90;
export const USAGE_LIMIT_MIN = 1;
export const USAGE_LIMIT_MAX = 500;
export const USAGE_LIMIT_DEFAULT = 100;
export const RATE_LIMIT_REQUESTS_PER_MINUTE = 30;
/** Daily api_requests counts are only available from this date onward (older days report 0). */
export const API_REQUESTS_CUTOFF_DATE = "2026-09-02";

export type UsageApiErrorKind =
  | "unauthorized"
  | "bad_request"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "server"
  | "malformed"
  | "network";

export class UsageApiError extends Error {
  readonly kind: UsageApiErrorKind;
  readonly retryAfterSeconds?: number;
  readonly status?: number;

  constructor(
    kind: UsageApiErrorKind,
    message: string,
    options: { retryAfterSeconds?: number; status?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "UsageApiError";
    this.kind = kind;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.status = options.status;
  }
}

export interface UsageRow {
  readonly date: string;
  readonly model: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly apiRequests: number;
}

export interface UsageModelTotals {
  readonly model: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly apiRequests: number;
}

export interface UsageTotals {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly apiRequests: number;
  readonly byModel: readonly UsageModelTotals[];
}

export interface UsageAllTime {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly apiRequests: number;
  readonly cachedAt: string;
}

export interface UsageReport {
  readonly object: "usage.report";
  /** Effective window actually served by the API, after any server-side clamping. */
  readonly startDate: string;
  readonly endDate: string;
  readonly rows: readonly UsageRow[];
  /** Full-window totals, independent of pagination. */
  readonly totals: UsageTotals;
  readonly allTime: UsageAllTime;
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

export interface UsagePageOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly startDate?: string;
  readonly endDate?: string;
  readonly cursor?: string;
  readonly limit?: number;
  readonly userAgent?: string;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
}

export interface UsageReportOptions extends UsagePageOptions {
  /** Safety cap on followed pages (each page is one rate-limited request). */
  readonly maxPages?: number;
}

/** Clamp a requested window client-side: never past today, never wider than 90 inclusive days. */
export function clampUsageWindow(
  startDate: string,
  endDate: string,
  today: string,
): { startDate: string; endDate: string } {
  const end = endDate < today ? endDate : today;
  const start = startDate < end ? startDate : end;
  const days = inclusiveDays(start, end);
  if (days <= MAX_USAGE_WINDOW_DAYS) {
    return { startDate: start, endDate: end };
  }
  // Keep the most recent MAX_USAGE_WINDOW_DAYS inclusive days (end is already ≤ today).
  const clampedStart = shiftUtcDate(end, -(MAX_USAGE_WINDOW_DAYS - 1));
  return { startDate: clampedStart > start ? clampedStart : start, endDate: end };
}

/** Clamp limit into 1..500; anything non-numeric or missing falls back to the 100 default. */
export function clampUsageLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return USAGE_LIMIT_DEFAULT;
  }
  const rounded = Math.trunc(value);
  if (rounded < USAGE_LIMIT_MIN) return USAGE_LIMIT_MIN;
  if (rounded > USAGE_LIMIT_MAX) return USAGE_LIMIT_MAX;
  return rounded;
}

/** Fetch one page of GET /v1/usage. Throws UsageApiError for every non-2xx or malformed body. */
export async function fetchUsagePage(options: UsagePageOptions): Promise<UsageReport> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = buildUsageUrl(options);
  const authScheme = "Bearer";
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `${authScheme} ${options.apiKey}`,
        Accept: "application/json",
        ...(options.userAgent ? { "User-Agent": options.userAgent } : {}),
      },
      signal: options.signal,
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    throw new UsageApiError("network", `Could not reach the NaN usage endpoint: ${errorMessage(error)}`, {
      cause: error,
    });
  }

  if (!response.ok) {
    throw await httpError(response);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new UsageApiError("malformed", "NaN Builders returned a usage response that is not valid JSON.", {
      status: response.status,
      cause: error,
    });
  }
  return parseUsageReport(payload);
}

/**
 * Fetch the full requested window, following next_cursor until exhausted.
 * Totals/all_time come from the first page because they already cover the whole window;
 * only rows are merged across pages.
 */
export async function fetchUsageReport(options: UsageReportOptions): Promise<UsageReport> {
  const maxPages = Math.max(1, options.maxPages ?? 3);
  let cursor = options.cursor;
  let merged: UsageReport | undefined;

  for (let page = 0; page < maxPages; page += 1) {
    const current = await fetchUsagePage({ ...options, cursor });
    if (!merged) {
      merged = current;
    } else {
      merged = { ...merged, rows: [...merged.rows, ...current.rows], hasMore: current.hasMore, nextCursor: current.nextCursor };
    }
    if (!current.hasMore || !current.nextCursor) {
      return { ...merged, hasMore: false, nextCursor: undefined };
    }
    cursor = current.nextCursor;
  }

  // Safety cap reached with rows still available: report hasMore so the caller knows.
  return { ...merged!, hasMore: true, nextCursor: cursor };
}

/** Validate and normalize an untrusted GET /v1/usage payload. Throws UsageApiError("malformed"). */
export function parseUsageReport(payload: unknown): UsageReport {
  const root = asObject(payload, "usage response");
  if (root.object !== "usage.report") {
    throw malformed('usage response "object" is not "usage.report"');
  }
  const startDate = asDate(root.start_date, "start_date");
  const endDate = asDate(root.end_date, "end_date");
  if (!Array.isArray(root.data)) {
    throw malformed('usage response "data" is not an array');
  }
  const rows = root.data.map((value, index) => parseRow(value, index));
  const totals = parseTotals(root.totals, "totals");
  const allTime = parseAllTime(root.all_time);
  const hasMore = root.has_more;
  if (typeof hasMore !== "boolean") {
    throw malformed('usage response "has_more" is not a boolean');
  }
  const nextCursor = root.next_cursor;
  if (nextCursor !== null && typeof nextCursor !== "string") {
    throw malformed('usage response "next_cursor" is not a string or null');
  }
  return {
    object: "usage.report",
    startDate,
    endDate,
    rows,
    totals,
    allTime,
    hasMore,
    nextCursor: nextCursor === null ? undefined : nextCursor,
  };
}

/**
 * Client-side guard for the documented 30 requests/minute/member budget.
 * Consumes one slot per request; throws rate_limited before the network call when exhausted.
 */
export class UsageRateLimiter {
  private readonly hits: number[] = [];

  constructor(
    private readonly limit = RATE_LIMIT_REQUESTS_PER_MINUTE,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  consume(): void {
    const current = this.now();
    this.prune(current);
    if (this.hits.length >= this.limit) {
      const oldest = this.hits[0];
      const retryAfterSeconds = Math.max(1, Math.ceil((oldest + this.windowMs - current) / 1_000));
      throw new UsageApiError(
        "rate_limited",
        `NaN Builders allows ${this.limit} usage queries per minute. Retry in ${retryAfterSeconds}s.`,
        { retryAfterSeconds },
      );
    }
    this.hits.push(current);
  }

  private prune(current: number): void {
    while (this.hits.length > 0 && this.hits[0] <= current - this.windowMs) {
      this.hits.shift();
    }
  }
}

function buildUsageUrl(options: UsagePageOptions): string {
  const base = options.baseUrl.replace(/\/+$/, "");
  const params = new URLSearchParams();
  if (options.startDate) params.set("start_date", options.startDate);
  if (options.endDate) params.set("end_date", options.endDate);
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.limit !== undefined) params.set("limit", String(clampUsageLimit(options.limit)));
  const query = params.toString();
  return query ? `${base}/usage?${query}` : `${base}/usage`;
}

async function httpError(response: Response): Promise<UsageApiError> {
  const status = response.status;
  const retryAfterSeconds = parseRetryAfter(response.headers.get("Retry-After"));
  const message = await serverMessage(response);
  if (status === 401 || status === 403) {
    return new UsageApiError(
      "unauthorized",
      "NaN Builders rejected the API key for the usage endpoint. Update it with 'NaN Builders: Manage Provider'.",
      { status },
    );
  }
  if (status === 429) {
    const wait = retryAfterSeconds !== undefined ? ` Retry in ${retryAfterSeconds}s.` : "";
    return new UsageApiError(
      "rate_limited",
      `NaN Builders rate limited usage queries (30 requests per minute).${wait}`,
      { status, retryAfterSeconds },
    );
  }
  if (status === 400) {
    return new UsageApiError("bad_request", message || "NaN Builders rejected the usage query parameters.", {
      status,
    });
  }
  if (status === 404) {
    return new UsageApiError(
      "not_found",
      message || "This member has no usage identity to report against yet.",
      { status },
    );
  }
  if (status === 409) {
    return new UsageApiError("conflict", message || "This API key alias cannot query usage.", { status });
  }
  if (status >= 500) {
    return new UsageApiError("server", `NaN Builders usage endpoint failed: HTTP ${status} ${response.statusText}`, {
      status,
    });
  }
  return new UsageApiError("network", `Unexpected NaN Builders usage response: HTTP ${status} ${response.statusText}`, {
    status,
  });
}

async function serverMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: { message?: unknown } };
    const message = payload?.error?.message;
    return typeof message === "string" && message.trim() ? message.trim() : "";
  } catch {
    return "";
  }
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : undefined;
}

function parseRow(value: unknown, index: number): UsageRow {
  const row = asObject(value, `usage row ${index}`);
  return {
    date: asDate(row.date, `data[${index}].date`),
    model: asString(row.model, `data[${index}].model`),
    promptTokens: asCount(row.prompt_tokens, `data[${index}].prompt_tokens`),
    completionTokens: asCount(row.completion_tokens, `data[${index}].completion_tokens`),
    totalTokens: asCount(row.total_tokens, `data[${index}].total_tokens`),
    apiRequests: asCount(row.api_requests, `data[${index}].api_requests`),
  };
}

function parseTotals(value: unknown, field: string): UsageTotals {
  const totals = asObject(value, field);
  const byModelRaw = totals.by_model;
  if (!Array.isArray(byModelRaw)) {
    throw malformed(`usage response "${field}.by_model" is not an array`);
  }
  return {
    promptTokens: asCount(totals.prompt_tokens, `${field}.prompt_tokens`),
    completionTokens: asCount(totals.completion_tokens, `${field}.completion_tokens`),
    totalTokens: asCount(totals.total_tokens, `${field}.total_tokens`),
    apiRequests: asCount(totals.api_requests, `${field}.api_requests`),
    byModel: byModelRaw.map((entry, index) => {
      const model = asObject(entry, `${field}.by_model[${index}]`);
      return {
        model: asString(model.model, `${field}.by_model[${index}].model`),
        promptTokens: asCount(model.prompt_tokens, `${field}.by_model[${index}].prompt_tokens`),
        completionTokens: asCount(model.completion_tokens, `${field}.by_model[${index}].completion_tokens`),
        totalTokens: asCount(model.total_tokens, `${field}.by_model[${index}].total_tokens`),
        apiRequests: asCount(model.api_requests, `${field}.by_model[${index}].api_requests`),
      };
    }),
  };
}

function parseAllTime(value: unknown): UsageAllTime {
  const allTime = asObject(value, "all_time");
  return {
    promptTokens: asCount(allTime.prompt_tokens, "all_time.prompt_tokens"),
    completionTokens: asCount(allTime.completion_tokens, "all_time.completion_tokens"),
    totalTokens: asCount(allTime.total_tokens, "all_time.total_tokens"),
    apiRequests: asCount(allTime.api_requests, "all_time.api_requests"),
    cachedAt: asString(allTime.cached_at, "all_time.cached_at"),
  };
}

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw malformed(`${what} is not an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) {
    throw malformed(`${field} is not a string`);
  }
  return value;
}

function asDate(value: unknown, field: string): string {
  const text = asString(value, field);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(Date.parse(`${text}T00:00:00Z`))) {
    throw malformed(`${field} is not a YYYY-MM-DD date`);
  }
  return text;
}

function asCount(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw malformed(`${field} is not a non-negative integer`);
  }
  return value;
}

function malformed(detail: string): UsageApiError {
  return new UsageApiError("malformed", `NaN Builders returned a malformed usage response (${detail}).`);
}

function inclusiveDays(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;
}

function shiftUtcDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
