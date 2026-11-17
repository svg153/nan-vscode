/**
 * Transparent retry of transient failures that happen *before* the gateway
 * streams a single byte (#151).
 *
 * Kept free of the `vscode` module so the policy is unit-testable: which
 * failures qualify, how long to wait, and how the wait reacts to cancellation.
 * The classification is not duplicated here — {@link preStreamRetryError}
 * reuses `providerErrors`, so `insufficient_quota`, every 4xx, and user
 * cancellation stay non-retryable by construction.
 *
 * Retry and failover (#144) compose instead of competing: `runWithFailover`
 * calls one attempt per profile, and each attempt retries on *its own* key
 * before the throttle error is allowed to travel up to the failover hop.
 */

import { RequestTimeoutError } from "./openai/request";
import { ProviderError, ProviderTimeoutError, toProviderError } from "./providerErrors";

/** Number setting: how many times one request is retried on the same key. */
export const RETRY_SETTING = "maxRetries";
/** Default retries, so two gateway blips do not fail a turn. `0` disables. */
export const DEFAULT_MAX_RETRIES = 2;
/** Upper bound, so a typo cannot turn one turn into a long retry storm. */
export const MAX_RETRIES_LIMIT = 5;
/** First backoff step; doubled per retry before jitter. */
export const RETRY_BASE_DELAY_MS = 500;
/**
 * Cap for both backoff and a gateway `Retry-After`. A wait is paid by the user
 * in front of a stalled turn, so a hostile or mistaken header cannot block it
 * for minutes; a longer throttle simply surfaces as the normal 429 error.
 */
export const MAX_RETRY_DELAY_MS = 8_000;

/** Clamps `nanBuilders.maxRetries` into a usable integer, `0` included. */
export function resolveMaxRetries(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_MAX_RETRIES;
  }
  return Math.min(MAX_RETRIES_LIMIT, Math.max(0, Math.floor(value)));
}

/**
 * Classifies a failure as retryable *only* while no response body has been
 * handed to the caller. Returns the mapped {@link ProviderError} so the caller
 * can honor its `Retry-After`, or `undefined` when the failure must surface.
 */
export function preStreamRetryError(error: unknown): ProviderError | undefined {
  if (isPostStreamTimeout(error)) {
    // The stream already started and then stalled: retrying would replay a
    // turn the user has partially seen, which #151 explicitly rules out.
    return undefined;
  }
  const mapped = toProviderError(error);
  return mapped instanceof ProviderError && mapped.retryable ? mapped : undefined;
}

/** Backoff for retry number `attempt` (1-based), or the capped `Retry-After`. */
export function retryDelayMs(options: {
  readonly attempt: number;
  readonly retryAfterSeconds?: number;
  /** Jitter source, seeded by tests. */
  readonly random?: () => number;
}): number {
  const { attempt, retryAfterSeconds } = options;
  if (retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds)) {
    return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, Math.ceil(retryAfterSeconds * 1_000)));
  }
  const step = Math.max(0, Math.floor(attempt) - 1);
  const ceiling = Math.min(MAX_RETRY_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** step);
  // Half jitter: every retry waits between 50% and 100% of the step, so two
  // clients throttled together do not retry in lockstep.
  const random = options.random ?? Math.random;
  const jitter = Math.min(1, Math.max(0, random()));
  return Math.round(ceiling / 2 + (ceiling / 2) * jitter);
}

/**
 * Waits `ms` while staying cancellable: a VS Code cancellation rejects
 * immediately with the abort reason, so the caller sends no further request.
 * The timer is always cleared, so a cancelled wait never keeps the extension
 * host awake or fires a late retry.
 */
export function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(retryCancelledError(signal));
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(retryCancelledError(signal));
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Reuses the abort reason when it is an error, so cancellation stays recognizable. */
function retryCancelledError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }
  const error = new Error("The NaN Builders request was cancelled while waiting to retry.");
  error.name = "AbortError";
  return error;
}

function isPostStreamTimeout(error: unknown): boolean {
  if (error instanceof RequestTimeoutError) {
    return error.kind !== "connect";
  }
  if (error instanceof ProviderTimeoutError) {
    return error.phase !== "connect";
  }
  return false;
}
