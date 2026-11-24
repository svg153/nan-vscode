/**
 * Pure inline-completion logic for the legacy `POST /completions` endpoint.
 *
 * Kept free of `vscode` imports so unit tests can cover payload boundaries,
 * cancellation, and malformed responses without a VS Code host.
 */

import { DEFAULT_COMPLETION_DEBOUNCE_MS, DEFAULT_COMPLETION_MAX_TOKENS } from "./completionTuning";
import type { HttpEndpointAuthorizer } from "./httpEndpointGuard";
import type { OpenAIUsage } from "./openai/types";
import { MAX_JSON_RESPONSE_BYTES, ResponseTooLargeError, readBoundedJson } from "./responseBody";
import type { SlotLease, SlotQueueRegistry } from "./openai/slotQueue";

/** Maximum prompt characters sent per request (tail ending at the cursor). */
export const MAX_PROMPT_CHARS = 4000;
/** Maximum suffix characters sent per request (head starting at the cursor). */
export const MAX_SUFFIX_CHARS = 1000;
/** Maximum characters returned as a ghost-text suggestion. */
export const MAX_SUGGESTION_CHARS = 1000;
/** Conservative generation budget so a suggestion stays interactive. */
export const MAX_COMPLETION_TOKENS = DEFAULT_COMPLETION_MAX_TOKENS;
export const INLINE_COMPLETION_DEBOUNCE_MS = DEFAULT_COMPLETION_DEBOUNCE_MS;

/** Client-error statuses a gateway answers when a request carries an unknown field. */
const SUFFIX_REJECTION_STATUSES: ReadonlySet<number> = new Set([400, 422]);

export type InlineCompletionScheduler = (delayMs: number, signal: AbortSignal) => Promise<void>;

export async function waitForInlineCompletionDebounce(
  signal: AbortSignal,
  schedule: InlineCompletionScheduler = scheduleDelay,
  delayMs: number = INLINE_COMPLETION_DEBOUNCE_MS,
): Promise<boolean> {
  if (signal.aborted) {
    return false;
  }
  await schedule(delayMs, signal);
  return !signal.aborted;
}

export interface CompletionRequest {
  model: string;
  prompt: string;
  /** Text right after the cursor for fill-in-the-middle; absent when unsupported or empty. */
  suffix?: string;
  max_tokens: number;
  temperature: number;
}

/**
 * Session-scoped memory of models whose gateway rejected the `suffix` field.
 * In memory only: a fresh extension session tries the suffix again instead of
 * persisting a capability guess in settings or global state.
 */
export interface CompletionSuffixSupport {
  supports(modelId: string): boolean;
  markUnsupported(modelId: string): void;
}

export function createCompletionSuffixSupport(): CompletionSuffixSupport {
  const unsupported = new Set<string>();
  return {
    supports: (modelId) => !unsupported.has(modelId.trim()),
    markUnsupported: (modelId) => {
      const id = modelId.trim();
      if (id) {
        unsupported.add(id);
      }
    },
  };
}

export type CompletionFailureReason = "cancelled" | "http" | "network" | "malformed" | "empty" | "too_large";

export type CompletionOutcome =
  | { ok: true; text: string; usage?: OpenAIUsage }
  | { ok: false; reason: CompletionFailureReason; status?: number };

export type CompletionParseResult =
  | { ok: true; text: string; usage?: OpenAIUsage }
  | { ok: false; reason: "malformed" | "empty" };

/**
 * Minimal view of `UsageTracker` needed to record one completion, so this
 * module stays free of `vscode` imports and testable with a fake tracker.
 */
export interface CompletionUsageRecorder {
  record(modelId: string, usage: OpenAIUsage | undefined): Promise<unknown>;
}

/**
 * Build the request body for one completion, or `undefined` when the feature
 * cannot run (no model configured, or nothing typed yet before the cursor).
 * The cursor offset is clamped to the document bounds, the prompt is clamped to
 * the last {@link MAX_PROMPT_CHARS} characters before the cursor, and the
 * suffix to the next {@link MAX_SUFFIX_CHARS} characters after it; only
 * documented API fields are produced.
 */
export function buildCompletionRequest(options: {
  model: string;
  documentText: string;
  cursorOffset: number;
  /** `false` when this model's gateway rejected `suffix` in this session. */
  supportsSuffix?: boolean;
  /** Resolved `nanBuilders.completionMaxTokens`; defaults to {@link MAX_COMPLETION_TOKENS}. */
  maxTokens?: number;
}): CompletionRequest | undefined {
  const model = options.model.trim();
  if (!model) {
    return undefined;
  }
  const text = options.documentText;
  const offset = Math.max(0, Math.min(options.cursorOffset, text.length));
  const prompt = text.slice(Math.max(0, offset - MAX_PROMPT_CHARS), offset);
  if (!prompt.trim()) {
    return undefined;
  }
  const suffix =
    options.supportsSuffix === false ? "" : text.slice(offset, Math.min(text.length, offset + MAX_SUFFIX_CHARS));
  return {
    model,
    prompt,
    ...(suffix ? { suffix } : {}),
    max_tokens: options.maxTokens ?? MAX_COMPLETION_TOKENS,
    temperature: 0,
  };
}

/**
 * Drop the end of a suggestion that repeats the start of the suffix, so a
 * fill-in-the-middle model that restates the following code does not duplicate
 * it when inserted. The longest overlap wins; no overlap leaves the text
 * unchanged.
 */
export function trimSuffixOverlap(suggestion: string, suffix: string): string {
  const limit = Math.min(suggestion.length, suffix.length);
  for (let length = limit; length > 0; length -= 1) {
    if (suggestion.endsWith(suffix.slice(0, length))) {
      return suggestion.slice(0, suggestion.length - length);
    }
  }
  return suggestion;
}

function withoutSuffix(request: CompletionRequest): CompletionRequest {
  const body: CompletionRequest = { ...request };
  delete body.suffix;
  return body;
}

/**
 * Keep only the non-negative integer counters of a provider `usage` object.
 * Strings, negatives, NaN, and fractions are dropped so local history cannot be
 * corrupted by a malformed body; an object without a usable counter yields
 * `undefined`, which callers treat as "no usage reported".
 */
export function parseCompletionUsage(value: unknown): OpenAIUsage | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const usage: OpenAIUsage = {};
  for (const key of ["prompt_tokens", "completion_tokens", "total_tokens"] as const) {
    const count = record[key];
    if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) {
      usage[key] = count;
    }
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/** Extract and sanitize the ghost text from a `text_completion` payload. */
export function parseCompletionResponse(payload: unknown): CompletionParseResult {
  if (typeof payload !== "object" || payload === null) {
    return { ok: false, reason: "malformed" };
  }
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return { ok: false, reason: "malformed" };
  }
  const first: unknown = choices[0];
  if (typeof first !== "object" || first === null) {
    return { ok: false, reason: "malformed" };
  }
  const rawText = (first as { text?: unknown }).text;
  if (typeof rawText !== "string") {
    return { ok: false, reason: "malformed" };
  }
  const normalized = rawText.replace(/\r\n?/g, "\n").replace(/^\n+/, "");
  const truncated = normalized.length > MAX_SUGGESTION_CHARS ? normalized.slice(0, MAX_SUGGESTION_CHARS) : normalized;
  if (!truncated.trim()) {
    return { ok: false, reason: "empty" };
  }
  const usage = parseCompletionUsage((payload as { usage?: unknown }).usage);
  return { ok: true, text: truncated, ...(usage ? { usage } : {}) };
}

/**
 * Record one settled completion in the local usage history. Cancelled, failed,
 * and usage-less responses are skipped so the aggregate only reflects requests
 * the gateway actually billed. Only the model ID and token counters reach the
 * recorder; prompt and suggestion text never leave this module.
 */
export async function recordCompletionUsage(
  recorder: CompletionUsageRecorder,
  modelId: string,
  outcome: CompletionOutcome,
): Promise<boolean> {
  if (!outcome.ok || !outcome.usage) {
    return false;
  }
  try {
    await recorder.record(modelId, outcome.usage);
    return true;
  } catch {
    return false;
  }
}

/** Transport settings shared by every attempt of one completion request. */
interface CompletionTransport {
  baseUrl: string;
  apiKey: string;
  userAgent: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  endpointAuthorizer?: HttpEndpointAuthorizer;
  /** Shared chat + inline slots for this API key, when queueing is enabled. */
  slotQueues?: Pick<SlotQueueRegistry, "acquire">;
}

/**
 * POST one completion. Never throws: HTTP failures, aborts, network errors,
 * and malformed bodies map to a non-ok outcome so callers can drop stale text.
 *
 * When a gateway rejects the `suffix` field with a client error, the request is
 * retried once without it and the model is remembered as suffix-less for the
 * session, so suggestions keep working on fill-in-the-middle unaware gateways.
 */
export async function requestInlineCompletion(
  options: CompletionTransport & {
    request: CompletionRequest;
    /** Session memory of models whose gateway rejected `suffix`. */
    suffixSupport?: CompletionSuffixSupport;
  },
): Promise<CompletionOutcome> {
  const request = options.request;
  const suffix =
    request.suffix && (options.suffixSupport?.supports(request.model) ?? true) ? request.suffix : "";
  const first = await sendCompletionOnce(options, suffix ? { ...request, suffix } : withoutSuffix(request));
  if (first.ok) {
    return suffix ? trimOverlap(first, suffix) : first;
  }
  if (!suffix || !isSuffixRejection(first)) {
    return first;
  }
  if (options.signal?.aborted) {
    return { ok: false, reason: "cancelled" };
  }
  const retry = await sendCompletionOnce(options, withoutSuffix(request));
  if (!retry.ok) {
    return retry;
  }
  options.suffixSupport?.markUnsupported(request.model);
  return trimOverlap(retry, suffix);
}

function isSuffixRejection(outcome: CompletionOutcome): boolean {
  return (
    !outcome.ok && outcome.reason === "http" && SUFFIX_REJECTION_STATUSES.has(outcome.status ?? 0)
  );
}

function trimOverlap(
  outcome: Extract<CompletionOutcome, { ok: true }>,
  suffix: string,
): CompletionOutcome {
  const text = trimSuffixOverlap(outcome.text, suffix);
  if (text === outcome.text) {
    return outcome;
  }
  if (!text.trim()) {
    return { ok: false, reason: "empty" };
  }
  return { ...outcome, text };
}

async function sendCompletionOnce(
  options: CompletionTransport,
  body: CompletionRequest,
): Promise<CompletionOutcome> {
  if (options.signal?.aborted) {
    return { ok: false, reason: "cancelled" };
  }
  const baseUrl = options.baseUrl;
  const url = `${baseUrl.replace(/\/+$/, "")}/completions`;
  try {
    await options.endpointAuthorizer?.authorize(baseUrl, options.signal);
  } catch (error) {
    return options.signal?.aborted || (error instanceof Error && error.name === "AbortError")
      ? { ok: false, reason: "cancelled" }
      : { ok: false, reason: "network" };
  }
  if (options.signal?.aborted) {
    return { ok: false, reason: "cancelled" };
  }
  const send = options.fetchImpl ?? fetch;
  // Queued behind other requests for the same key instead of racing the
  // gateway's concurrency limit; a cancelled waiter returns before any fetch.
  let slot: SlotLease | undefined;
  if (options.slotQueues) {
    try {
      slot = await options.slotQueues.acquire(options.apiKey, options.signal);
    } catch {
      return { ok: false, reason: "cancelled" };
    }
  }
  try {
    if (options.signal?.aborted) {
      return { ok: false, reason: "cancelled" };
    }
    let response: Response;
    try {
      response = await send(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
          "User-Agent": options.userAgent,
        },
        body: JSON.stringify(body),
        signal: options.signal ?? null,
      });
    } catch {
      return options.signal?.aborted ? { ok: false, reason: "cancelled" } : { ok: false, reason: "network" };
    }
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        // The body may already be consumed or locked; nothing to release.
      }
      return { ok: false, reason: "http", status: response.status };
    }
    try {
      const payload: unknown = await readBoundedJson(response, MAX_JSON_RESPONSE_BYTES);
      return parseCompletionResponse(payload);
    } catch (error) {
      if (error instanceof ResponseTooLargeError) {
        return { ok: false, reason: "too_large" };
      }
      return options.signal?.aborted ? { ok: false, reason: "cancelled" } : { ok: false, reason: "malformed" };
    }
  } finally {
    slot?.release();
  }
}

function scheduleDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    timer = setTimeout(finish, delayMs);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) {
      finish();
    }
  });
}
