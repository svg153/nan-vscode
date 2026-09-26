/**
 * Pure inline-completion logic for the legacy `POST /completions` endpoint.
 *
 * Kept free of `vscode` imports so unit tests can cover payload boundaries,
 * cancellation, and malformed responses without a VS Code host.
 */

/** Maximum prompt characters sent per request (tail ending at the cursor). */
export const MAX_PROMPT_CHARS = 4000;
/** Maximum characters returned as a ghost-text suggestion. */
export const MAX_SUGGESTION_CHARS = 1000;
/** Conservative generation budget so a suggestion stays interactive. */
export const MAX_COMPLETION_TOKENS = 64;

export interface CompletionRequest {
  model: string;
  prompt: string;
  max_tokens: number;
  temperature: number;
}

export type CompletionFailureReason = "cancelled" | "http" | "network" | "malformed" | "empty";

export type CompletionOutcome =
  | { ok: true; text: string }
  | { ok: false; reason: CompletionFailureReason; status?: number };

export type CompletionParseResult = { ok: true; text: string } | { ok: false; reason: "malformed" | "empty" };

/**
 * Build the request body for one completion, or `undefined` when the feature
 * cannot run (no model configured, cursor out of range, or nothing typed yet).
 * The prompt is clamped to the last {@link MAX_PROMPT_CHARS} characters before
 * the cursor and only documented API fields are produced.
 */
export function buildCompletionRequest(options: {
  model: string;
  documentText: string;
  cursorOffset: number;
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
  return {
    model,
    prompt,
    max_tokens: MAX_COMPLETION_TOKENS,
    temperature: 0,
  };
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
  if (!normalized.trim()) {
    return { ok: false, reason: "empty" };
  }
  return {
    ok: true,
    text: normalized.length > MAX_SUGGESTION_CHARS ? normalized.slice(0, MAX_SUGGESTION_CHARS) : normalized,
  };
}

/**
 * POST one completion. Never throws: HTTP failures, aborts, network errors,
 * and malformed bodies map to a non-ok outcome so callers can drop stale text.
 */
export async function requestInlineCompletion(options: {
  baseUrl: string;
  apiKey: string;
  userAgent: string;
  request: CompletionRequest;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<CompletionOutcome> {
  if (options.signal?.aborted) {
    return { ok: false, reason: "cancelled" };
  }
  const send = options.fetchImpl ?? fetch;
  const url = `${options.baseUrl.replace(/\/+$/, "")}/completions`;
  let response: Response;
  try {
    response = await send(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": options.userAgent,
      },
      body: JSON.stringify(options.request),
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
    const payload: unknown = await response.json();
    return parseCompletionResponse(payload);
  } catch {
    return options.signal?.aborted ? { ok: false, reason: "cancelled" } : { ok: false, reason: "malformed" };
  }
}
