import { sanitizeUpstreamText } from "./text";

/**
 * User-facing classification of gateway and transport failures. The value says
 * what happened and what the user can do about it, which is not the same as the
 * HTTP status: NaN uses 429 both for a throttle and for an exhausted credit
 * pool, and reports the real cause in `error.code`.
 */
export type ProviderErrorCode =
  | "invalid_api_key"
  | "insufficient_quota"
  | "rate_limit_exceeded"
  | "model_not_found"
  | "context_length_exceeded"
  | "timeout"
  | "network"
  | "cancelled"
  | "gateway_error"
  | "unknown";

export interface ProviderErrorDetails {
  readonly status?: number;
  readonly statusText?: string;
  /** Raw response body; only structural `type`/`code`/`param` fields survive sanitizing. */
  readonly body?: string;
  readonly retryAfterSeconds?: number;
  readonly aborted?: boolean;
  /** A thrown value, when classifying a transport failure instead of an HTTP response. */
  readonly error?: unknown;
}

export interface ProviderErrorInfo {
  readonly code: ProviderErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
}

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;

  constructor(info: ProviderErrorInfo) {
    super(info.message);
    this.name = "ProviderError";
    this.code = info.code;
    this.retryable = info.retryable;
    this.retryAfterSeconds = info.retryAfterSeconds;
  }
}

/**
 * Timeout raised by the transport timers (connect headers and stream idle).
 * The provider maps this to a timeout message, never to a cancellation, so a
 * stalled gateway is never reported as something the user did.
 */
export class ProviderTimeoutError extends Error {
  constructor(
    readonly phase: "connect" | "stream" = "connect",
    readonly timeoutMs?: number,
  ) {
    super(`NaN Builders ${phase} timed out${timeoutMs !== undefined ? ` after ${timeoutMs} ms` : ""}.`);
    this.name = "ProviderTimeoutError";
  }
}

const CANCELLED_MESSAGE = "The NaN Builders request was cancelled before it completed.";

const TIMEOUT_MESSAGE =
  "The NaN Builders request timed out before it completed. Retry, or check your network connection if it " +
  "keeps happening.";

const NETWORK_MESSAGE =
  "Could not reach NaN Builders. Check your network connection and the nanBuilders.apiBaseUrl setting, then retry.";

const GATEWAY_MESSAGE =
  "NaN Builders returned a gateway error. Retry shortly, or try a different model if it persists.";

const MODEL_NOT_FOUND_MESSAGE =
  "The model was not found on this endpoint. Run 'NaN Builders: Refresh Models' to reload the catalog, and " +
  "check the nanBuilders.apiBaseUrl setting if the model should exist.";

const CONTEXT_LENGTH_MESSAGE =
  "The conversation exceeded the model's context window. Trim the chat history or start a new chat, then retry.";

const INVALID_KEY_MESSAGE =
  "NaN Builders rejected the API key. Update it with 'NaN Builders: Manage Provider'.";

const INVALID_KEY_ACCESS_MESSAGE =
  "NaN Builders rejected the API key or this key lacks access to the requested model. Update it with " +
  "'NaN Builders: Manage Provider', or ask the key owner for access.";

/**
 * HTTP 402 is the only symptom of an exhausted or frozen credit pool, so the
 * message names the three causes the user can act on instead of staying cryptic.
 */
const CREDITS_REFUSED_HINT =
  "NaN Builders bills every metered model from one credits pool, so this request was refused because the " +
  "plan allowance is spent, credits are frozen, or no credit pack is active. Run 'NaN Builders: Show Usage' " +
  "for the balance, or use a model that does not draw credits.";

const MAX_SUMMARY_LENGTH = 200;
const MAX_FIELD_LENGTH = 64;

const RETRYABLE_CODES: ReadonlySet<ProviderErrorCode> = new Set([
  "rate_limit_exceeded",
  "timeout",
  "network",
  "gateway_error",
]);

/**
 * Pure mapping from HTTP status plus `error.code`/`error.type` to an actionable
 * message. Kept free of `vscode` and `fetch` so it is unit-testable directly.
 */
export function mapProviderError(details: ProviderErrorDetails): ProviderErrorInfo {
  if (details.error !== undefined || details.aborted) {
    return mapThrownError(details);
  }
  return mapHttpError(details);
}

/** Classifies a thrown transport error without changing errors that are not transport-related. */
export function toProviderError(error: unknown): unknown {
  if (error instanceof ProviderError) {
    return error;
  }
  if (isAbortError(error) || isTimeoutError(error) || isNetworkError(error)) {
    return new ProviderError(mapProviderError({ error }));
  }
  return error;
}

export function httpError(
  status: number,
  statusText: string,
  body: string,
  retryAfterSeconds?: number,
): ProviderError {
  return new ProviderError(mapProviderError({ status, statusText, body, retryAfterSeconds }));
}

/**
 * Upstream bodies can echo the request, including user prompt text and API
 * keys. Only structural error identifiers are surfaced; free-form messages are
 * dropped entirely.
 */
export function sanitizeErrorBody(body: string): string {
  const fields = readErrorFields(body);
  const parts = [fields.type, fields.code, fields.param].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return parts.length > 0
    ? sanitizeUpstreamText(parts.join(" "), MAX_SUMMARY_LENGTH).slice(0, MAX_SUMMARY_LENGTH)
    : "";
}

export function parseRetryAfter(header: string | null, now: number = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds >= 0 ? Math.ceil(seconds) : undefined;

  const retryAt = Date.parse(header);
  if (!Number.isFinite(retryAt) || !Number.isFinite(now) || retryAt <= now) return undefined;
  return Math.ceil((retryAt - now) / 1_000);
}

function mapHttpError(details: ProviderErrorDetails): ProviderErrorInfo {
  const { status, statusText, retryAfterSeconds } = details;
  const summary = sanitizeErrorBody(details.body ?? "");
  const structural = classifyStructuralCode(details.body ?? "");

  if (status === undefined) {
    const code = structural ?? "unknown";
    const message =
      code === "unknown"
        ? summary
          ? `NaN Builders request failed: ${summary}`
          : "NaN Builders request failed."
        : actionMessage(code, { retryAfterSeconds });
    return info(code, message, { retryAfterSeconds });
  }

  // Authentication statuses and 402 are authoritative: a key that cannot
  // authenticate or a billing refusal is never a throttle or a model problem.
  const code =
    status === 401 || status === 403
      ? "invalid_api_key"
      : status === 402
        ? "insufficient_quota"
        : (structural ?? statusCode(status));

  const prefix = statusPrefix(status, statusText ?? "", summary);
  const message =
    code === "unknown" ? prefix : `${prefix} — ${actionMessage(code, { status, retryAfterSeconds })}`;
  return info(code, message, { retryAfterSeconds });
}

function mapThrownError(details: ProviderErrorDetails): ProviderErrorInfo {
  const { error, aborted, retryAfterSeconds } = details;
  if (isTimeoutError(error)) {
    return info("timeout", TIMEOUT_MESSAGE, { retryAfterSeconds });
  }
  if (aborted || isAbortError(error)) {
    return info("cancelled", CANCELLED_MESSAGE);
  }
  if (error instanceof ProviderError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      retryAfterSeconds: error.retryAfterSeconds,
    };
  }
  if (isNetworkError(error)) {
    return info("network", NETWORK_MESSAGE);
  }
  const summary = sanitizeUpstreamText(error instanceof Error ? error.message : String(error ?? ""), MAX_SUMMARY_LENGTH);
  return info("unknown", summary ? `NaN Builders request failed: ${summary}` : "NaN Builders request failed.");
}

function statusCode(status: number): ProviderErrorCode {
  if (status === 404) return "model_not_found";
  if (status === 408 || status === 504) return "timeout";
  if (status === 429) return "rate_limit_exceeded";
  if (status >= 500 && status <= 599) return "gateway_error";
  return "unknown";
}

function actionMessage(
  code: ProviderErrorCode,
  context: { readonly status?: number; readonly retryAfterSeconds?: number },
): string {
  switch (code) {
    case "invalid_api_key":
      return context.status === 403 ? INVALID_KEY_ACCESS_MESSAGE : INVALID_KEY_MESSAGE;
    case "insufficient_quota":
      return CREDITS_REFUSED_HINT;
    case "rate_limit_exceeded":
      return context.retryAfterSeconds !== undefined
        ? `NaN Builders rate limited this request. Retry in ${context.retryAfterSeconds}s.`
        : "NaN Builders rate limited this request. Wait a moment before retrying.";
    case "model_not_found":
      return MODEL_NOT_FOUND_MESSAGE;
    case "context_length_exceeded":
      return CONTEXT_LENGTH_MESSAGE;
    case "timeout":
      return TIMEOUT_MESSAGE;
    case "network":
      return NETWORK_MESSAGE;
    case "cancelled":
      return CANCELLED_MESSAGE;
    case "gateway_error":
      return GATEWAY_MESSAGE;
    default:
      return "";
  }
}

function info(
  code: ProviderErrorCode,
  message: string,
  options: { readonly retryAfterSeconds?: number } = {},
): ProviderErrorInfo {
  return {
    code,
    message,
    retryable: RETRYABLE_CODES.has(code),
    retryAfterSeconds: code === "rate_limit_exceeded" ? options.retryAfterSeconds : undefined,
  };
}

function statusPrefix(status: number, statusText: string, summary: string): string {
  const text = statusText ? ` ${sanitizeUpstreamText(statusText, MAX_FIELD_LENGTH)}` : "";
  const suffix = summary ? `: ${summary}` : "";
  return `NaN Builders API error ${status}${text}${suffix}`;
}

function classifyStructuralCode(body: string): ProviderErrorCode | undefined {
  const fields = readErrorFields(body);
  // `code` is the narrower identifier: gateways pair a broad `rate_limit_exceeded`
  // type with `insufficient_quota` to say the credits pool is empty, and that
  // must not be reported as a retryable throttle.
  for (const value of [fields.code, fields.type, fields.param]) {
    const code = classifyCode(value);
    if (code) {
      return code;
    }
  }
  return undefined;
}

function classifyCode(value: string | undefined): ProviderErrorCode | undefined {
  if (!value) {
    return undefined;
  }
  const code = value.toLowerCase();
  if (/insufficient_quota|insufficient_balance|credit|quota|billing|payment_required/.test(code)) {
    return "insufficient_quota";
  }
  if (/model_not_found|model_not_available|no_such_model|unknown_model|invalid_model|model_deprecated/.test(code)) {
    return "model_not_found";
  }
  if (/context_length|context_window|maximum_context|prompt_too_long|too_many_tokens/.test(code)) {
    return "context_length_exceeded";
  }
  if (/rate_limit|too_many_requests|throttl|slow_down|overloaded/.test(code)) {
    return "rate_limit_exceeded";
  }
  if (/invalid_api_key|invalid_token|unauthorized|authentication|access_denied|forbidden/.test(code)) {
    return "invalid_api_key";
  }
  if (/timeout|timed_out|etimedout/.test(code)) {
    return "timeout";
  }
  return undefined;
}

interface ErrorFields {
  readonly type?: string;
  readonly code?: string;
  readonly param?: string;
}

function readErrorFields(body: string): ErrorFields {
  const trimmed = body.trim();
  if (!trimmed) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object") {
    return {};
  }
  const root = parsed as { error?: unknown; type?: unknown; code?: unknown; param?: unknown };
  const source =
    root.error && typeof root.error === "object" ? (root.error as Record<string, unknown>) : root;
  return {
    type: fieldValue(source.type),
    code: fieldValue(source.code),
    param: fieldValue(source.param),
  };
}

function fieldValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, MAX_FIELD_LENGTH) : undefined;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isTimeoutError(error: unknown): boolean {
  if (error instanceof ProviderTimeoutError) {
    return true;
  }
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as { name?: unknown; code?: unknown };
  return (
    candidate.name === "TimeoutError" ||
    candidate.name === "ProviderTimeoutError" ||
    candidate.code === "timeout" ||
    candidate.code === "ETIMEDOUT"
  );
}

function isNetworkError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  // `fetch` reports DNS and connection failures as `TypeError: fetch failed`
  // with the real cause attached, so a bare TypeError from our own code must
  // not be reported as a network problem.
  if (error instanceof TypeError) {
    return /fetch|network/i.test(error.message);
  }
  const code = (error as { code?: unknown }).code;
  return (
    typeof code === "string" &&
    /^(ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH)/.test(code)
  );
}
