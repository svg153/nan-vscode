import {
  UsageApiError,
  UsageRateLimiter,
  UsageReport,
  clampUsageWindow,
  fetchUsageReport,
} from "./usageApi";
import { creditProgress, percentOf, unmeteredNote } from "./quotaCatalog";
import type { HttpEndpointAuthorizer } from "./httpEndpointGuard";

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
const REFRESH_TIMEOUT_MS = 30_000;

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

  constructor(
    private readonly config: AccountUsageConfigSource,
    private readonly endpointAuthorizer?: HttpEndpointAuthorizer,
  ) {}

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
    const requestController = new AbortController();
    const externalSignal = options.signal;
    const forwardExternalAbort = () => requestController.abort(externalSignal?.reason);
    if (externalSignal?.aborted) {
      forwardExternalAbort();
    } else {
      externalSignal?.addEventListener("abort", forwardExternalAbort, { once: true });
    }

    const timeoutError = new UsageApiError("timeout", "NaN Builders usage refresh timed out after 30 seconds.");
    let didTimeout = false;
    let rejectTimeout!: (error: UsageApiError) => void;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      rejectTimeout = reject;
    });
    const timeoutHandle = setTimeout(() => {
      didTimeout = true;
      requestController.abort(timeoutError);
      rejectTimeout(timeoutError);
    }, REFRESH_TIMEOUT_MS);

    try {
      const report = await Promise.race([
        fetchUsageReport({
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
          startDate: window.startDate,
          endDate: window.endDate,
          signal: requestController.signal,
          fetchImpl,
          endpointAuthorizer: this.endpointAuthorizer,
        }),
        timeoutPromise,
      ]);
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
      throw this.recordError(didTimeout ? timeoutError : error);
    } finally {
      clearTimeout(timeoutHandle);
      externalSignal?.removeEventListener("abort", forwardExternalAbort);
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
  /** Credits billed on this model in the window; undefined when the row carries none. */
  readonly credits?: number;
  /** Share of the plan's credit allowance used by this model (1 decimal); undefined means "do not fabricate %". */
  readonly percent?: number;
  /** Note when no % applies, e.g. "Does not draw credits" or "No credits billed in this window". */
  readonly note?: string;
}

/** Per-model rows for a usage report, sorted by total tokens desc, with % of plan credits where documented. */
export function accountModelRows(report: UsageReport): AccountModelRow[] {
  const allowance = report.credits?.allowance;
  const progress = new Map(
    creditProgress(
      report.totals.byModel.map((entry) => ({ model: entry.model, credits: entry.credits ?? 0 })),
      allowance,
    ).map((entry) => [entry.model, entry.percent]),
  );
  return [...report.totals.byModel]
    // oxlint-disable-next-line unicorn/no-array-sort
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .map((entry) => {
      const percent = progress.get(entry.model);
      return {
        model: entry.model,
        promptTokens: entry.promptTokens,
        completionTokens: entry.completionTokens,
        totalTokens: entry.totalTokens,
        apiRequests: entry.apiRequests,
        credits: entry.credits,
        percent,
        note: percent === undefined ? creditsNote(entry.model, entry.credits) : undefined,
      };
    });
}

/** Plan-credits headline: the share of the allowance used this period, or undefined when not billed in credits. */
export function accountHeadline(report: UsageReport): { model: string; percent: number } | undefined {
  const { allowance, used } = report.credits ?? {};
  if (allowance === undefined || !Number.isFinite(allowance) || allowance <= 0 || used === undefined) {
    return undefined;
  }
  return { model: "credits", percent: percentOf(used, allowance) };
}

function creditsNote(model: string, credits: number | undefined): string | undefined {
  const unmetered = unmeteredNote(model);
  if (unmetered) {
    return unmetered;
  }
  return credits === undefined || credits <= 0 ? "No credits billed in this window" : undefined;
}

function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}
