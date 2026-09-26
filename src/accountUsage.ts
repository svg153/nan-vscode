import {
  UsageApiError,
  UsageRateLimiter,
  UsageReport,
  clampUsageWindow,
  fetchUsageReport,
} from "./usageApi";
import { monthlyQuotaProgress, NO_TOKEN_COUNTER_MODELS, nonMonthlyQuotaNote } from "./quotaCatalog";

export interface AccountUsageConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
}

export interface AccountUsageRefreshOptions {
  /** Reference date for the current-month window (defaults to today, UTC). */
  readonly today?: string;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
  /** Bypass the refresh throttle (user-triggered refresh). */
  readonly force?: boolean;
}

export interface AccountUsageSnapshot {
  /** Effective window actually served by the API. */
  readonly startDate: string;
  readonly endDate: string;
  readonly fetchedAt: string;
  readonly report: UsageReport;
}

export interface AccountUsageError {
  readonly message: string;
  readonly retryAfterSeconds?: number;
  readonly at: string;
}

const MIN_REFRESH_INTERVAL_MS = 60_000;

export type AccountUsageConfigSource = () => AccountUsageConfig | undefined | Promise<AccountUsageConfig | undefined>;

/**
 * Holds the account-wide usage snapshot for the status-bar tooltip and QuickPick.
 * A failed refresh keeps the previous snapshot and records lastError instead, so
 * stale-but-real data is never hidden because one request failed.
 */
export class AccountUsageService {
  private snapshotValue?: AccountUsageSnapshot;
  private lastErrorValue?: AccountUsageError;
  private lastAttemptAtMs = 0;
  private loadingValue = false;
  private readonly limiter = new UsageRateLimiter();

  constructor(private readonly config: AccountUsageConfigSource) {}

  get snapshot(): AccountUsageSnapshot | undefined {
    return this.snapshotValue;
  }

  get lastError(): AccountUsageError | undefined {
    return this.lastErrorValue;
  }

  get loading(): boolean {
    return this.loadingValue;
  }

  /**
   * Refresh the current-month window (YYYY-MM-01..today, at most 90 days wide).
   * Throws UsageApiError (or AbortError) after recording the failure; the caller
   * decides whether to surface it (manual refresh) or ignore it (background).
   */
  async refresh(options: AccountUsageRefreshOptions = {}): Promise<AccountUsageSnapshot> {
    const config = await this.config();
    if (!config) {
      throw this.recordError(new UsageApiError("unauthorized", "No API key is configured for NaN Builders."));
    }

    const now = Date.now();
    if (!options.force && this.snapshotValue && now - this.lastAttemptAtMs < MIN_REFRESH_INTERVAL_MS) {
      return this.snapshotValue;
    }

    this.lastAttemptAtMs = now;
    try {
      this.limiter.consume();
    } catch (error) {
      throw this.recordError(error);
    }

    const today = options.today ?? utcToday();
    const window = clampUsageWindow(monthStart(today), today, today);
    const fetchImpl = options.fetchImpl ?? fetch;

    this.loadingValue = true;
    try {
      const report = await fetchUsageReport({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        startDate: window.startDate,
        endDate: window.endDate,
        signal: options.signal,
        fetchImpl,
      });
      const snapshot: AccountUsageSnapshot = {
        startDate: report.startDate,
        endDate: report.endDate,
        fetchedAt: new Date().toISOString(),
        report,
      };
      this.snapshotValue = snapshot;
      this.lastErrorValue = undefined;
      return snapshot;
    } catch (error) {
      throw this.recordError(error);
    } finally {
      this.loadingValue = false;
    }
  }

  /** Records lastError for UsageApiError; other errors (e.g. AbortError) pass through untouched. */
  private recordError(error: unknown): unknown {
    if (error instanceof UsageApiError) {
      this.lastErrorValue = {
        message: error.message,
        retryAfterSeconds: error.retryAfterSeconds,
        at: new Date().toISOString(),
      };
    }
    return error;
  }
}

function monthStart(today: string): string {
  return `${today.slice(0, 7)}-01`;
}

export interface AccountModelRow {
  readonly model: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly apiRequests: number;
  /** Monthly fixed-counter % (1 decimal) when NaN publishes one; undefined means "do not fabricate %". */
  readonly percent?: number;
  /** Quota note when no monthly % applies, e.g. "No token counter" or a billing-period quota. */
  readonly note?: string;
}

/** Per-model rows for a usage report, sorted by total tokens desc, with % only where documented. */
export function accountModelRows(report: UsageReport): AccountModelRow[] {
  const progress = new Map(
    monthlyQuotaProgress(
      report.totals.byModel.map((entry) => ({ model: entry.model, totalTokens: entry.totalTokens })),
    ).map((entry) => [entry.model, entry.percent]),
  );
  return [...report.totals.byModel]
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .map((entry) => {
      const percent = progress.get(entry.model);
      return {
        model: entry.model,
        promptTokens: entry.promptTokens,
        completionTokens: entry.completionTokens,
        totalTokens: entry.totalTokens,
        apiRequests: entry.apiRequests,
        percent,
        note: percent === undefined ? quotaNote(entry.model) : undefined,
      };
    });
}

/** Most-restricted monthly quota: the status-bar headline percent, or undefined when none applies. */
export function accountHeadline(report: UsageReport): { model: string; percent: number } | undefined {
  const [top] = monthlyQuotaProgress(
    report.totals.byModel.map((entry) => ({ model: entry.model, totalTokens: entry.totalTokens })),
  );
  return top ? { model: top.model, percent: top.percent } : undefined;
}

function quotaNote(model: string): string | undefined {
  if (NO_TOKEN_COUNTER_MODELS.has(model)) {
    return "No token counter";
  }
  return nonMonthlyQuotaNote(model);
}

function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}
