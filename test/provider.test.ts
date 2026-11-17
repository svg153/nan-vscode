import assert from "node:assert/strict";
import test from "node:test";
import {
  convertMessages,
  convertTools,
  estimateTokens,
  isImagePart,
  RequestTimeoutError,
} from "../src/openai/request";
import { ProviderError, ProviderTimeoutError, httpError } from "../src/providerErrors";
import {
  DEFAULT_MAX_RETRIES,
  MAX_RETRIES_LIMIT,
  MAX_RETRY_DELAY_MS,
  preStreamRetryError,
  resolveMaxRetries,
  retryDelayMs,
  waitForRetry,
} from "../src/retry";

const noMapping = new Map<string, string>();

test("converts a plain user message into a single text message", () => {
  const messages = convertMessages([{ role: "user", content: [{ value: "hello" }] }], noMapping);
  assert.deepEqual(messages, [{ role: "user", content: "hello" }]);
});

test("joins multiple text parts into one string", () => {
  const messages = convertMessages([{ role: "assistant", content: [{ value: "a" }, { value: "b" }] }], noMapping);
  assert.deepEqual(messages, [{ role: "assistant", content: "ab" }]);
});

test("converts tool calls and tool results into separate messages", () => {
  const mapping = new Map([["read.file", "read_file"]]);
  const messages = convertMessages(
    [
      {
        role: "assistant",
        content: [
          { value: "reading" },
          { callId: "call-1", name: "read.file", input: { path: "a.ts" } },
        ],
      },
      { role: "user", content: [{ callId: "call-1", content: [{ value: "contents" }] }] },
    ],
    mapping,
  );

  assert.deepEqual(messages, [
    {
      role: "assistant",
      content: "reading",
      tool_calls: [
        { id: "call-1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
      ],
    },
    { role: "tool", tool_call_id: "call-1", content: "contents" },
  ]);
});

test("sanitizes tool names that are missing from the mapping", () => {
  const messages = convertMessages(
    [{ role: "assistant", content: [{ callId: "c", name: "mcp.server/read", input: {} }] }],
    noMapping,
  );
  assert.equal(messages[0].tool_calls?.[0].function.name, "mcp_server_read");
});

test("emits null content when an assistant turn only contains tool calls", () => {
  const messages = convertMessages(
    [{ role: "assistant", content: [{ callId: "c", name: "t", input: {} }] }],
    noMapping,
  );
  assert.equal(messages[0].content, null);
});

test("converts image parts into base64 data URLs", () => {
  const data = new Uint8Array([1, 2, 3]);
  const messages = convertMessages([{ role: "user", content: [{ mimeType: "image/png", data }] }], noMapping);
  assert.deepEqual(messages, [
    {
      role: "user",
      content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${Buffer.from(data).toString("base64")}` } }],
    },
  ]);
});

test("keeps mixed text and image parts as an array", () => {
  const messages = convertMessages(
    [{ role: "user", content: [{ value: "look" }, { mimeType: "image/png", data: new Uint8Array([0]) }] }],
    noMapping,
  );
  assert.equal(Array.isArray(messages[0].content), true);
  assert.equal((messages[0].content as unknown[]).length, 2);
});

test("flattens string and structured tool result content", () => {
  const messages = convertMessages(
    [{ role: "user", content: [{ callId: "c", content: ["plain", { value: "text" }, { ok: true }] }] }],
    noMapping,
  );
  assert.equal(messages[0].content, 'plaintext{"ok":true}');
});

test("ignores parts that are not recognized", () => {
  const messages = convertMessages([{ role: "user", content: [{ unknown: true }] }], noMapping);
  assert.deepEqual(messages, []);
});

test("builds tool definitions with sanitized names and schemas", () => {
  const mapping = convertTools(
    [{ name: "mcp.read", description: "reads", inputSchema: { type: "object", properties: { p: { type: "string" } } } }],
    false,
  );

  assert.equal(mapping.definitions.length, 1);
  assert.equal(mapping.definitions[0].function.name, "mcp_read");
  assert.equal(mapping.definitions[0].function.description, "reads");
  assert.deepEqual(mapping.definitions[0].function.parameters, {
    type: "object",
    properties: { p: { type: "string" } },
  });
  assert.equal(mapping.originalToSanitized.get("mcp.read"), "mcp_read");
  assert.equal(mapping.sanitizedToOriginal.get("mcp_read"), "mcp.read");
  assert.equal(mapping.toolChoice, "auto");
});

test("falls back to an empty object schema for invalid tool schemas", () => {
  const mapping = convertTools([{ name: "t", inputSchema: "not-a-schema" }], false);
  assert.deepEqual(mapping.definitions[0].function.parameters, { type: "object", properties: {} });
});

test("forces required tool choice when the caller requests it", () => {
  assert.equal(convertTools([{ name: "t" }], true).toolChoice, "required");
});

test("leaves tool choice undefined when no tools are provided", () => {
  const mapping = convertTools([], false);
  assert.equal(mapping.definitions.length, 0);
  assert.equal(mapping.toolChoice, undefined);
});

test("estimates tokens with a floor of one", () => {
  assert.equal(estimateTokens(""), 1);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
});

test("formats HTTP errors with status, status text and structural error fields", () => {
  const error = httpError(429, "Too Many Requests", '{"error":{"type":"rate_limit","code":"slow_down"}}');
  assert.equal(
    error.message,
    "NaN Builders API error 429 Too Many Requests: rate_limit slow_down — NaN Builders rate limited this " +
      "request. Wait a moment before retrying.",
  );
  assert.equal(error.code, "rate_limit_exceeded");
});

test("omits the body suffix when the response body is empty", () => {
  assert.equal(
    httpError(500, "Internal Server Error", "   ").message,
    "NaN Builders API error 500 Internal Server Error — NaN Builders returned a gateway error. Retry shortly, " +
      "or try a different model if it persists.",
  );
});

test("redacts and bounds untrusted HTTP status text", () => {
  const statusText = `Bearer abcdef123456 ${"x".repeat(100)}\r\nInjected`;
  const error = httpError(500, statusText, "");
  assert.equal(error.message.includes("abcdef123456"), false);
  assert.equal(error.message.includes("\r"), false);
  assert.equal(error.message.includes("Injected"), false);
  assert.equal(error.message.startsWith(`NaN Builders API error 500 ****** ${"x".repeat(57)} — `), true);
});

test("does not echo prompt content from long upstream bodies", () => {
  const prompt = "my private prompt ".repeat(40);
  const error = httpError(400, "Bad Request", JSON.stringify({ error: { message: prompt } }));
  assert.equal(error.message, "NaN Builders API error 400 Bad Request");
  assert.equal(error.message.includes("my private prompt"), false);
});

test("drops non-JSON bodies instead of surfacing them", () => {
  const error = httpError(502, "Bad Gateway", "<html>upstream echoed the request body</html>");
  assert.equal(error.message.includes("upstream echoed the request body"), false);
  assert.equal(
    error.message,
    "NaN Builders API error 502 Bad Gateway — NaN Builders returned a gateway error. Retry shortly, or try a " +
      "different model if it persists.",
  );
});

test("redacts credential-like tokens in structural error fields", () => {
  const error = httpError(401, "Unauthorized", '{"error":{"code":"sk-live-abc123456","type":"auth"}}');
  assert.equal(error.message.includes("sk-live-abc123456"), false);
  assert.equal(
    error.message.startsWith(
      "NaN Builders API error 401 Unauthorized: auth ****** — NaN Builders rejected the API key. Update it with " +
        "'NaN Builders: Manage Provider'.",
    ),
    true,
  );
  assert.equal(error.code, "invalid_api_key");
});

test("redacts bearer tokens in structural error fields", () => {
  const error = httpError(401, "Unauthorized", '{"error":{"code":"Bearer abcdef123456"}}');
  assert.equal(error.message.includes("abcdef123456"), false);
});

test("bounds the sanitized summary length", () => {
  const error = httpError(400, "Bad Request", JSON.stringify({ error: { type: "t".repeat(400) } }));
  assert.equal(error.message.length, "NaN Builders API error 400 Bad Request: ".length + 64);
});

test("explains the credit reasons behind an HTTP 402 instead of leaving it cryptic", () => {
  const error = httpError(402, "Payment Required", '{"error":{"type":"insufficient_balance"}}');
  assert.match(error.message, /^NaN Builders API error 402 Payment Required: insufficient_balance — /);
  assert.match(error.message, /one credits pool/);
  assert.match(error.message, /credits are frozen/);
  assert.match(error.message, /NaN Builders: Show Usage/);
  assert.match(httpError(402, "Payment Required", "").message, /does not draw credits\.$/);
});

test("timeout errors are explicit, actionable, and never worded as cancellation", () => {
  const connect = new RequestTimeoutError("connect", 20);
  assert.equal(connect.name, "RequestTimeoutError");
  assert.equal(connect.kind, "connect");
  assert.match(connect.message, /did not send response headers within 20 seconds/);
  assert.match(connect.message, /nanBuilders\.connectTimeoutSeconds/);

  const idle = new RequestTimeoutError("stream-idle", 120);
  assert.match(idle.message, /no stream data for 120 seconds/);
  assert.match(idle.message, /nanBuilders\.streamIdleTimeoutSeconds/);

  for (const error of [connect, idle]) {
    assert.match(error.message, /timed out/);
    assert.equal(/cancel/i.test(error.message), false);
  }
});

test("detects image parts only for image mime types backed by bytes", () => {
  assert.equal(isImagePart({ mimeType: "image/png", data: new Uint8Array([0]) }), true);
  assert.equal(isImagePart({ mimeType: "text/plain", data: new Uint8Array([0]) }), false);
  assert.equal(isImagePart({ mimeType: "image/png", data: "not-bytes" }), false);
  assert.equal(isImagePart(null), false);
});

test("maxRetries defaults to 2 and ignores values that would retry forever", () => {
  assert.equal(DEFAULT_MAX_RETRIES, 2);
  assert.equal(resolveMaxRetries(undefined), 2);
  assert.equal(resolveMaxRetries("3"), 2);
  assert.equal(resolveMaxRetries(Number.NaN), 2);
  assert.equal(resolveMaxRetries(Number.POSITIVE_INFINITY), 2);
  assert.equal(resolveMaxRetries(0), 0);
  assert.equal(resolveMaxRetries(1.9), 1);
  assert.equal(resolveMaxRetries(-4), 0);
  assert.equal(resolveMaxRetries(99), MAX_RETRIES_LIMIT);
});

test("only pre-stream transient failures qualify for a retry", () => {
  const throttle = preStreamRetryError(httpError(429, "Too Many Requests", "", 1));
  assert.ok(throttle instanceof ProviderError);
  assert.equal(throttle.code, "rate_limit_exceeded");
  assert.equal(throttle.retryAfterSeconds, 1);

  for (const status of [502, 503]) {
    const gateway = preStreamRetryError(httpError(status, "Gateway", ""));
    assert.ok(gateway instanceof ProviderError, `HTTP ${status} is transient`);
    assert.equal(gateway.code, "gateway_error");
  }
  // 504 is reported as the timeout it is, and is equally worth retrying.
  const gatewayTimeout = preStreamRetryError(httpError(504, "Gateway Timeout", ""));
  assert.ok(gatewayTimeout instanceof ProviderError);
  assert.equal(gatewayTimeout.code, "timeout");

  const connect = preStreamRetryError(new RequestTimeoutError("connect", 20));
  assert.ok(connect instanceof ProviderError);
  assert.equal(connect.code, "timeout");

  const network = preStreamRetryError(new TypeError("fetch failed"));
  assert.ok(network instanceof ProviderError);
  assert.equal(network.code, "network");

  // A 429 that means "credits are spent" is a billing answer, not a throttle:
  // retrying it only burns turns and hides the real cause.
  assert.equal(
    preStreamRetryError(httpError(429, "Too Many Requests", '{"error":{"code":"insufficient_quota"}}')),
    undefined,
  );
  assert.equal(preStreamRetryError(httpError(402, "Payment Required", "")), undefined);
  for (const status of [400, 401, 403, 404, 413, 422]) {
    assert.equal(preStreamRetryError(httpError(status, "Error", "")), undefined, `HTTP ${status} is final`);
  }

  // The stream already started: replaying it would duplicate a partially seen turn.
  assert.equal(preStreamRetryError(new RequestTimeoutError("stream-idle", 120)), undefined);
  assert.equal(preStreamRetryError(new ProviderTimeoutError("stream")), undefined);
  assert.equal(preStreamRetryError(new Error("boom")), undefined);
});

test("a retry waits for the gateway Retry-After, capped, before any backoff", () => {
  assert.equal(retryDelayMs({ attempt: 1, retryAfterSeconds: 1 }), 1_000);
  assert.equal(retryDelayMs({ attempt: 1, retryAfterSeconds: 0 }), 0);
  assert.equal(retryDelayMs({ attempt: 1, retryAfterSeconds: 1.4 }), 1_400);
  assert.equal(retryDelayMs({ attempt: 1, retryAfterSeconds: 3_600 }), MAX_RETRY_DELAY_MS);
  assert.equal(retryDelayMs({ attempt: 1, retryAfterSeconds: Number.NaN, random: () => 0 }), 250);
});

test("backoff doubles per retry, stays inside half-to-full jitter, and is capped", () => {
  const ceiling = (attempt: number): number => retryDelayMs({ attempt, random: () => 1 });
  assert.equal(ceiling(1), 500);
  assert.equal(ceiling(2), 1_000);
  assert.equal(ceiling(3), 2_000);
  assert.equal(ceiling(5), MAX_RETRY_DELAY_MS);
  assert.equal(ceiling(20), MAX_RETRY_DELAY_MS);

  for (const attempt of [1, 2, 3, 4, 5, 20]) {
    const floorDelay = retryDelayMs({ attempt, random: () => 0 });
    const ceilDelay = retryDelayMs({ attempt, random: () => 1 });
    assert.equal(floorDelay, Math.round(ceilDelay / 2));
    assert.ok(floorDelay <= ceilDelay);
    assert.ok(ceilDelay <= MAX_RETRY_DELAY_MS);
  }
  // A jitter source outside [0, 1) must not escape the window either.
  assert.equal(retryDelayMs({ attempt: 1, random: () => 5 }), 500);
  assert.equal(retryDelayMs({ attempt: 1, random: () => -5 }), 250);
});

test("a retry wait resolves on its timer and rejects as soon as the turn is cancelled", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const resolved = waitForRetry(400, new AbortController().signal);
  t.mock.timers.tick(400);
  await resolved;

  const controller = new AbortController();
  const pending = waitForRetry(8_000, controller.signal);
  let settled: "resolved" | "rejected" | undefined;
  pending.then(
    () => {
      settled = "resolved";
    },
    () => {
      settled = "rejected";
    },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, undefined);

  controller.abort(new Error("The user cancelled the request."));
  await assert.rejects(pending, /cancelled/);
  // The timer was cleared, so a cancelled wait cannot fire a late retry.
  t.mock.timers.tick(8_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, "rejected");

  await assert.rejects(waitForRetry(1_000, AbortSignal.abort()), { name: "AbortError" });
});
