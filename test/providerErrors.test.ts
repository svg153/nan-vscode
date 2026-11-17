import assert from "node:assert/strict";
import test from "node:test";
import {
  ProviderError,
  ProviderTimeoutError,
  httpError,
  mapProviderError,
  sanitizeErrorBody,
  toProviderError,
} from "../src/providerErrors";

test("classifies 401 and 403 as an API key problem", () => {
  const unauthorized = mapProviderError({ status: 401, statusText: "Unauthorized", body: "" });
  assert.equal(unauthorized.code, "invalid_api_key");
  assert.equal(unauthorized.retryable, false);
  assert.match(unauthorized.message, /Manage Provider/);

  const forbidden = mapProviderError({ status: 403, statusText: "Forbidden", body: "" });
  assert.equal(forbidden.code, "invalid_api_key");
  assert.match(forbidden.message, /lacks access/);
});

test("classifies 402 as an exhausted or frozen credits pool", () => {
  const info = mapProviderError({ status: 402, statusText: "Payment Required", body: "" });
  assert.equal(info.code, "insufficient_quota");
  assert.match(info.message, /one credits pool/);
  assert.match(info.message, /credits are frozen/);
  assert.match(info.message, /NaN Builders: Show Usage/);
  assert.equal(info.message.includes("API error 402 Payment Required"), true);
  assert.equal(info.message.endsWith("API error 402 Payment Required"), false);
});

test("classifies 429 with insufficient_quota as credits, not a throttle", () => {
  const info = mapProviderError({
    status: 429,
    statusText: "Too Many Requests",
    body: '{"error":{"type":"insufficient_quota"}}',
  });
  assert.equal(info.code, "insufficient_quota");
  assert.match(info.message, /NaN Builders: Show Usage/);
});

test("prefers a specific error.code over a broader error.type on a 429", () => {
  const info = mapProviderError({
    status: 429,
    statusText: "Too Many Requests",
    body: '{"error":{"type":"rate_limit_exceeded","code":"insufficient_quota"}}',
  });
  assert.equal(info.code, "insufficient_quota");
  assert.equal(info.retryable, false);
  assert.match(info.message, /NaN Builders: Show Usage/);
  assert.equal(info.message.includes("Wait a moment before retrying"), false);
});

test("classifies a plain 429 as a retryable throttle", () => {
  const info = mapProviderError({ status: 429, statusText: "Too Many Requests", body: "" });
  assert.equal(info.code, "rate_limit_exceeded");
  assert.equal(info.retryable, true);
  assert.match(info.message, /rate limited this request/);
  assert.match(info.message, /Wait a moment before retrying/);
});

test("cites Retry-After seconds on a 429 when the header is present", () => {
  const info = mapProviderError({ status: 429, statusText: "Too Many Requests", body: "", retryAfterSeconds: 30 });
  assert.match(info.message, /Retry in 30s\./);
  assert.equal(info.retryAfterSeconds, 30);
});

test("classifies 404 as a missing model and points at the catalog", () => {
  const info = mapProviderError({
    status: 404,
    statusText: "Not Found",
    body: '{"error":{"type":"model_not_found"}}',
  });
  assert.equal(info.code, "model_not_found");
  assert.match(info.message, /NaN Builders: Refresh Models/);
  assert.match(info.message, /nanBuilders\.apiBaseUrl/);
});

test("uses error.code without an HTTP status", () => {
  const info = mapProviderError({ body: '{"error":{"code":"model_not_found"}}' });
  assert.equal(info.code, "model_not_found");
  assert.match(info.message, /Refresh Models/);
});

test("classifies context_length_exceeded and suggests trimming history", () => {
  const info = mapProviderError({ status: 400, statusText: "Bad Request", body: '{"error":{"code":"context_length_exceeded"}}' });
  assert.equal(info.code, "context_length_exceeded");
  assert.match(info.message, /context window/);
  assert.match(info.message, /Trim the chat history/);
});

test("classifies 408 and 504 as timeouts, not cancellations", () => {
  for (const status of [408, 504]) {
    const info = mapProviderError({ status, statusText: "Timeout", body: "" });
    assert.equal(info.code, "timeout");
    assert.equal(info.retryable, true);
    assert.match(info.message, /timed out/);
    assert.equal(info.message.includes("cancelled"), false);
  }
});

test("classifies transport timeouts from the thrown error shapes", () => {
  const fromClass = mapProviderError({ error: new ProviderTimeoutError("connect", 20_000) });
  assert.equal(fromClass.code, "timeout");
  assert.match(fromClass.message, /timed out/);

  const named = Object.assign(new Error("no headers"), { name: "TimeoutError" });
  assert.equal(mapProviderError({ error: named }).code, "timeout");

  const coded = Object.assign(new Error("deadline"), { code: "timeout" });
  assert.equal(mapProviderError({ error: coded }).code, "timeout");
});

test("keeps cancellation and timeout messages distinct", () => {
  const cancelled = mapProviderError({ aborted: true });
  const timedOut = mapProviderError({ error: new ProviderTimeoutError("stream", 120_000) });
  assert.equal(cancelled.code, "cancelled");
  assert.equal(cancelled.message.includes("cancelled"), true);
  assert.equal(cancelled.message.includes("timed out"), false);
  assert.equal(timedOut.code, "timeout");
  assert.equal(timedOut.message.includes("timed out"), true);
  assert.equal(timedOut.message.includes("cancelled"), false);
  assert.notEqual(cancelled.message, timedOut.message);

  const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
  assert.equal(mapProviderError({ error: abortError }).code, "cancelled");
});

test("classifies 5xx as a retryable gateway error", () => {
  for (const status of [500, 502, 503]) {
    const info = mapProviderError({ status, statusText: "Server Error", body: "" });
    assert.equal(info.code, "gateway_error");
    assert.equal(info.retryable, true);
    assert.match(info.message, /gateway error/);
  }
});

test("falls back to the sanitized body without leaking secrets", () => {
  const info = mapProviderError({
    status: 400,
    statusText: "Bad Request",
    body: '{"error":{"type":"invalid_request","code":"sk-live-abc123456","message":"echoed prompt"}}',
  });
  assert.equal(info.code, "unknown");
  assert.match(info.message, /^NaN Builders API error 400 Bad Request: invalid_request \*{6}/);
  assert.equal(info.message.includes("sk-live-abc123456"), false);
  assert.equal(info.message.includes("echoed prompt"), false);
  assert.equal(sanitizeErrorBody('{"error":{"code":"Bearer abcdef123456"}}').includes("abcdef123456"), false);
});

test("classifies network failures as a reachability problem", () => {
  assert.equal(mapProviderError({ error: new TypeError("fetch failed") }).code, "network");
  const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  assert.equal(mapProviderError({ error: refused }).code, "network");
  assert.match(mapProviderError({ error: refused }).message, /Could not reach NaN Builders/);
});

test("does not report an unrelated TypeError as a network failure", () => {
  const info = mapProviderError({ error: new TypeError("Cannot read properties of undefined") });
  assert.equal(info.code, "unknown");
  assert.equal(info.message.includes("Could not reach NaN Builders"), false);
});

test("sanitizes the message of an unrecognized thrown error", () => {
  const info = mapProviderError({ error: new Error("Bearer abcdef123456 failed") });
  assert.equal(info.code, "unknown");
  assert.equal(info.message.includes("abcdef123456"), false);
  assert.match(info.message, /NaN Builders request failed:/);
});

test("httpError returns a typed provider error", () => {
  const error = httpError(402, "Payment Required", '{"error":{"type":"insufficient_balance"}}');
  assert.equal(error instanceof ProviderError, true);
  assert.equal(error.code, "insufficient_quota");
  assert.equal(error.retryable, false);
});

test("toProviderError maps transport failures and preserves application errors", () => {
  const appError = Object.assign(new Error("stream limit"), { name: "StreamLimitError" });
  assert.equal(toProviderError(appError), appError);

  const timeout = new ProviderTimeoutError("connect", 20_000);
  const mapped = toProviderError(timeout);
  assert.equal(mapped instanceof ProviderError, true);
  assert.equal((mapped as ProviderError).code, "timeout");

  const providerError = httpError(401, "Unauthorized", "");
  assert.equal(toProviderError(providerError), providerError);
});
