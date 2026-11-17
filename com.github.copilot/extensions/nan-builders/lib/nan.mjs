// NaN Builders API client for the Copilot app plugin (dependency-free, ESM).
// Mirrors src/usageApi.ts and src/modelCatalog.ts contract rules:
// - GET /v1/models, GET /v1/usage (inclusive day window <= 90 days, cursor paging,
//   <= 30 req/min), POST /v1/chat/completions.
// - Never logs or echoes the API key; error messages are redacted.

export const DEFAULT_BASE_URL = "https://api.nan.builders/v1";
export const USAGE_WINDOW_MAX_DAYS = 90;
const USAGE_PAGE_LIMIT = 500;
const USAGE_MAX_PAGES = 3;
const REQUEST_TIMEOUT_MS = 20_000;
const RESPONSE_MAX_BYTES = 4 * 1024 * 1024;

export class NanError extends Error {
  constructor(kind, message, status) {
    super(message);
    this.name = "NanError";
    this.kind = kind;
    if (status !== undefined) {
      this.status = status;
    }
  }
}

const NON_CHAT_MODEL_IDS = new Set([
  "qwen3-embedding",
  "rerank",
  "kokoro",
  "whisper",
  "flux-2-klein",
  "qwen-image-2.1",
]);

const KNOWN_CHAT_IDS = new Set([
  "deepseek-v4-flash", "glm5.3-flash", "qwen3.8-flash", "mimo-v2.6-flash",
  "gemma4", "qwen3.6", "glm5.3", "kimi-k3.1-pro", "qwen3.8-max", "qwen4-max",
  "deepseek-v4-pro", "hy4", "hy4-flash",
]);

const CHAT_MODEL_TYPES = new Set(["chat", "llm", "text"]);

export function normalizeBaseUrl(url) {
  const trimmed = String(url ?? "").trim().replace(/\/+$/, "");
  return trimmed || DEFAULT_BASE_URL;
}

/** "https" | "http-loopback" | "http-insecure" | "invalid" */
export function classifyBaseUrl(url) {
  let parsed;
  try {
    parsed = new URL(normalizeBaseUrl(url));
  } catch {
    return "invalid";
  }
  if (parsed.protocol === "https:") {
    return "https";
  }
  if (parsed.protocol === "http:") {
    const host = parsed.hostname.toLowerCase();
    const loopback = host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
    return loopback ? "http-loopback" : "http-insecure";
  }
  return "invalid";
}

export function redactSecret(text, secret) {
  const value = String(text ?? "");
  if (!secret) {
    return value;
  }
  return value.split(secret).join("[redacted]");
}

/** Inclusive UTC current-month window, clamped to <= 90 days. */
export function monthUtcWindow(now = new Date()) {
  const endDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), 1));
  let startDate = start;
  const days = (endDate.getTime() - start.getTime()) / 86_400_000 + 1;
  if (days > USAGE_WINDOW_MAX_DAYS) {
    startDate = new Date(endDate.getTime() - (USAGE_WINDOW_MAX_DAYS - 1) * 86_400_000);
  }
  return { startDate: isoDateUtc(startDate), endDate: isoDateUtc(endDate) };
}

function isoDateUtc(d) {
  return d.toISOString().slice(0, 10);
}

/** Conservative chat-model predicate mirroring modelCatalog.ts isChatModel. */
export function isChatModel(entry) {
  const id = String(entry?.id ?? "").trim();
  if (!id || NON_CHAT_MODEL_IDS.has(id)) {
    return false;
  }
  if (entry.is_chat === false) {
    return false;
  }
  if (entry.is_chat === true) {
    return true;
  }
  if (typeof entry.model_type === "string") {
    return CHAT_MODEL_TYPES.has(entry.model_type.toLowerCase());
  }
  return KNOWN_CHAT_IDS.has(id);
}

function httpErrorKind(status, body) {
  const apiMessage = (() => {
    try {
      const parsed = JSON.parse(body);
      const m = parsed?.error?.message || parsed?.message;
      return typeof m === "string" && m.length > 0 ? `: ${m.slice(0, 300)}` : "";
    } catch {
      return "";
    }
  })();
  switch (status) {
    case 400: return new NanError("bad_request", "NaN API rejected the request" + apiMessage, status);
    case 401: return new NanError("unauthorized", "NaN API rejected the API key (401)" + apiMessage, status);
    case 403: return new NanError("forbidden", "NaN API denied access (403)" + apiMessage, status);
    case 404: return new NanError("not_found", "NaN API endpoint not found (404)" + apiMessage, status);
    case 409: return new NanError("conflict", "NaN API conflict (409)" + apiMessage, status);
    case 429: return new NanError("rate_limited", "NaN API rate limit hit (429), retry shortly" + apiMessage, status);
    default:
      if (status >= 500) {
        return new NanError("server_error", `NaN API server error (${status})` + apiMessage, status);
      }
      return new NanError("http_error", `NaN API returned ${status}` + apiMessage, status);
  }
}

async function requestJson(cfg, path, options = {}) {
  const safety = classifyBaseUrl(cfg.baseUrl);
  if (safety === "invalid") {
    throw new NanError("bad_request", "Base URL is not a valid http(s) URL.");
  }
  if (safety === "http-insecure") {
    throw new NanError("confirmation_required", "Plain HTTP to a non-loopback host is not allowed.");
  }
  const { method = "GET", body, query, timeoutMs = REQUEST_TIMEOUT_MS } = options;
  const url = new URL(cfg.baseUrl + path);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  const headers = { Authorization: "Bearer " + cfg.apiKey, Accept: "application/json" };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new NanError("network", "NaN API request failed: " + redactSecret(error?.message, cfg.apiKey));
  }
  const text = await readBounded(response, cfg);
  if (!response.ok) {
    throw httpErrorKind(response.status, text);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new NanError("malformed", "NaN API returned a non-JSON response.", response.status);
  }
}

async function readBounded(response, cfg) {
  if (!response.body) {
    return response.text();
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.length;
    if (total > RESPONSE_MAX_BYTES) {
      await reader.cancel();
      throw new NanError("malformed", "NaN API response exceeded the size limit.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}

export async function fetchModels(cfg) {
  const json = await requestJson(cfg, "/models");
  const data = Array.isArray(json?.data) ? json.data : [];
  return data
    .filter((entry) => entry && typeof entry === "object" && typeof entry.id === "string" && entry.id.trim())
    .map((entry) => ({ id: entry.id.trim(), is_chat: entry.is_chat, model_type: entry.model_type }));
}

export async function fetchUsage(cfg, window) {
  const range = window ?? monthUtcWindow();
  const rows = [];
  let totals = null;
  let allTime = null;
  let credits;
  let cursor;
  let hasMore = false;
  for (let page = 0; page < USAGE_MAX_PAGES; page += 1) {
    const json = await requestJson(cfg, "/usage", {
      query: {
        start_date: range.startDate,
        end_date: range.endDate,
        limit: USAGE_PAGE_LIMIT,
        cursor,
      },
    });
    if (json?.object !== "usage.report") {
      throw new NanError("malformed", "NaN API returned an unexpected usage payload.");
    }
    if (Array.isArray(json.data)) {
      for (const row of json.data) {
        if (row && typeof row === "object") {
          rows.push(row);
        }
      }
    }
    if (!totals && json.totals) {
      totals = json.totals;
    }
    if (!allTime && json.all_time) {
      allTime = json.all_time;
    }
    if (credits === undefined && json.credits !== undefined && json.credits !== null) {
      credits = normalizeCredits(json.credits);
    }
    hasMore = json.has_more === true;
    cursor = typeof json.next_cursor === "string" && json.next_cursor ? json.next_cursor : undefined;
    if (!hasMore || !cursor) {
      break;
    }
  }
  return {
    startDate: range.startDate,
    endDate: range.endDate,
    truncated: hasMore && cursor !== undefined,
    rows,
    totals: normalizeTotals(totals),
    credits,
    allTime: allTime && typeof allTime === "object" ? normalizeTotals(allTime) : null,
  };
}

/**
 * Plan credits for the current billing period (`credits` on GET /v1/usage).
 * Gateways that predate the credits model omit the block: undefined then, so the
 * caller degrades to token counts instead of inventing a percentage. A block
 * whose every field is missing or invalid is equally unusable and also returns
 * undefined, so an empty object never masks the fallback with a blank headline.
 */
function normalizeCredits(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const credits = {
    allowance: num(value.allowance),
    used: num(value.used),
    remaining: num(value.remaining),
    packCredits: num(value.pack_credits),
    packExpiresAt: str(value.pack_expires_at),
    periodStart: str(value.period_start),
    periodEnd: str(value.period_end),
    frozen: typeof value.frozen === "boolean" ? value.frozen : undefined,
  };
  const normalized = Object.fromEntries(Object.entries(credits).filter(([, entry]) => entry !== undefined));
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeTotals(totals) {
  const t = totals && typeof totals === "object" ? totals : {};
  const byModelRaw = Array.isArray(t.by_model) ? t.by_model : [];
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const optionalNum = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  return {
    promptTokens: num(t.prompt_tokens),
    completionTokens: num(t.completion_tokens),
    totalTokens: num(t.total_tokens),
    apiRequests: num(t.api_requests),
    credits: optionalNum(t.credits),
    byModel: byModelRaw
      .filter((entry) => entry && typeof entry === "object" && typeof entry.model === "string")
      .map((entry) => ({
        model: entry.model,
        promptTokens: num(entry.prompt_tokens),
        completionTokens: num(entry.completion_tokens),
        totalTokens: num(entry.total_tokens),
        apiRequests: num(entry.api_requests),
        credits: optionalNum(entry.credits),
      })),
  };
}

export async function createChatCompletion(cfg, { model, prompt, system, maxTokens, temperature }) {
  const messages = [];
  if (system) {
    messages.push({ role: "system", content: String(system) });
  }
  messages.push({ role: "user", content: String(prompt) });
  const body = { model, messages, stream: false };
  if (typeof maxTokens === "number" && maxTokens > 0) {
    body.max_tokens = Math.min(Math.floor(maxTokens), 32_768);
  }
  if (typeof temperature === "number" && Number.isFinite(temperature)) {
    body.temperature = Math.min(Math.max(temperature, 0), 2);
  }
  const json = await requestJson(cfg, "/chat/completions", { method: "POST", body, timeoutMs: 60_000 });
  const choice = Array.isArray(json?.choices) ? json.choices[0] : undefined;
  const text = typeof choice?.message?.content === "string" ? choice.message.content : "";
  const usage = json?.usage && typeof json.usage === "object" ? json.usage : undefined;
  return {
    text,
    model: typeof json?.model === "string" ? json.model : model,
    usage: usage
      ? {
          promptTokens: usage.prompt_tokens ?? 0,
          completionTokens: usage.completion_tokens ?? 0,
          totalTokens: usage.total_tokens ?? 0,
        }
      : undefined,
  };
}
