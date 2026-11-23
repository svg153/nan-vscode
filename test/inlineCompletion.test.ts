import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_COMPLETION_TOKENS,
  INLINE_COMPLETION_DEBOUNCE_MS,
  MAX_PROMPT_CHARS,
  MAX_SUFFIX_CHARS,
  MAX_SUGGESTION_CHARS,
  buildCompletionRequest,
  createCompletionSuffixSupport,
  parseCompletionResponse,
  parseCompletionUsage,
  recordCompletionUsage,
  requestInlineCompletion,
  trimSuffixOverlap,
  waitForInlineCompletionDebounce,
  type CompletionOutcome,
} from "../src/inlineCompletion";
import type { OpenAIUsage } from "../src/openai/types";
import { MAX_JSON_RESPONSE_BYTES } from "../src/responseBody";
import { SlotQueueRegistry, credentialId } from "../src/openai/slotQueue";
import { addUsage, type DailyUsage } from "../src/usageHistory";

const LONG_TEXT = "x".repeat(MAX_PROMPT_CHARS * 2);

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("buildCompletionRequest requires a non-empty model", () => {
  assert.equal(
    buildCompletionRequest({ model: "", documentText: "const x = 1", cursorOffset: 11 }),
    undefined,
  );
  assert.equal(
    buildCompletionRequest({ model: "   ", documentText: "const x = 1", cursorOffset: 11 }),
    undefined,
  );
});

test("buildCompletionRequest sends only the tail before the cursor", () => {
  const documentText = "a".repeat(MAX_PROMPT_CHARS) + "TAIL_MARKER";
  const request = buildCompletionRequest({
    model: "glm5.3-flash",
    documentText,
    cursorOffset: documentText.length,
  });
  assert.ok(request);
  assert.equal(request.prompt, documentText.slice(documentText.length - MAX_PROMPT_CHARS));
  assert.equal(request.prompt.length, MAX_PROMPT_CHARS);
  assert.ok(!request.prompt.endsWith("TAIL_MARKER") || request.prompt.length <= MAX_PROMPT_CHARS);
});

test("buildCompletionRequest clamps a cursor beyond the document", () => {
  const request = buildCompletionRequest({
    model: "glm5.3-flash",
    documentText: "hello",
    cursorOffset: 999,
  });
  assert.ok(request);
  assert.equal(request.prompt, "hello");
});

test("buildCompletionRequest skips empty or whitespace-only prompts", () => {
  assert.equal(buildCompletionRequest({ model: "m", documentText: "", cursorOffset: 0 }), undefined);
  assert.equal(
    buildCompletionRequest({ model: "m", documentText: "   \n  ", cursorOffset: 6 }),
    undefined,
  );
});

test("buildCompletionRequest stays within documented bounds and fields", () => {
  const request = buildCompletionRequest({
    model: "glm5.3-flash",
    documentText: LONG_TEXT + "tail",
    cursorOffset: LONG_TEXT.length + 4,
  });
  assert.ok(request);
  assert.equal(request.max_tokens, MAX_COMPLETION_TOKENS);
  assert.equal(request.temperature, 0);
  assert.ok(request.prompt.length <= MAX_PROMPT_CHARS);
  // oxlint-disable-next-line unicorn/no-array-sort
  assert.deepEqual(Object.keys(request).sort(), ["max_tokens", "model", "prompt", "temperature"]);
});

test("buildCompletionRequest sends a bounded suffix after a mid-document cursor", () => {
  const before = "const value = ";
  const after = "compute(" + "y".repeat(MAX_SUFFIX_CHARS * 2);
  const request = buildCompletionRequest({
    model: "glm5.3-flash",
    documentText: before + after,
    cursorOffset: before.length,
  });
  assert.ok(request);
  assert.equal(request.prompt, before);
  assert.equal(request.suffix, after.slice(0, MAX_SUFFIX_CHARS));
  assert.equal(request.suffix?.length, MAX_SUFFIX_CHARS);
});

test("buildCompletionRequest omits the suffix at the end of the document", () => {
  const request = buildCompletionRequest({
    model: "glm5.3-flash",
    documentText: "const x = 1",
    cursorOffset: 11,
  });
  assert.ok(request);
  assert.equal("suffix" in request, false);
  // oxlint-disable-next-line unicorn/no-array-sort
  assert.deepEqual(Object.keys(request).sort(), ["max_tokens", "model", "prompt", "temperature"]);
});

test("buildCompletionRequest omits the suffix for models that rejected it", () => {
  const request = buildCompletionRequest({
    model: "glm5.3-flash",
    documentText: "const value = 1;",
    cursorOffset: 14,
    supportsSuffix: false,
  });
  assert.ok(request);
  assert.equal("suffix" in request, false);
});

test("trimSuffixOverlap removes the suggestion tail that repeats the suffix start", () => {
  assert.equal(trimSuffixOverlap("return total", "total_balance;"), "return ");
  assert.equal(trimSuffixOverlap("total_balance;", "total_balance; rest"), "");
  assert.equal(trimSuffixOverlap("alpha", "beta"), "alpha");
  assert.equal(trimSuffixOverlap("", "suffix"), "");
});

test("createCompletionSuffixSupport remembers rejected models per session", () => {
  const support = createCompletionSuffixSupport();
  assert.equal(support.supports("glm5.3-flash"), true);
  support.markUnsupported(" glm5.3-flash ");
  assert.equal(support.supports("glm5.3-flash"), false);
  assert.equal(support.supports("qwen3.8-flash"), true);
  support.markUnsupported("   ");
  assert.equal(support.supports(""), true);
});

test("inline debounce uses the fixed quiet period and an injectable scheduler", async () => {
  const controller = new AbortController();
  const delays: number[] = [];
  const ready = await waitForInlineCompletionDebounce(controller.signal, async (delayMs, signal) => {
    assert.equal(signal, controller.signal);
    delays.push(delayMs);
  });

  assert.equal(ready, true);
  assert.deepEqual(delays, [INLINE_COMPLETION_DEBOUNCE_MS]);
  assert.equal(INLINE_COMPLETION_DEBOUNCE_MS, 150);
});

test("inline debounce resolves as canceled when its signal aborts", async () => {
  const controller = new AbortController();
  let scheduledDelay = 0;
  const pending = waitForInlineCompletionDebounce(controller.signal, (delayMs, signal) => {
    scheduledDelay = delayMs;
    return new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  });

  controller.abort();
  assert.equal(await pending, false);
  assert.equal(scheduledDelay, INLINE_COMPLETION_DEBOUNCE_MS);
});

test("parseCompletionResponse normalizes newlines and strips leading blank lines", () => {
  const result = parseCompletionResponse({
    choices: [{ text: "\r\n  const y = 2;\r" }],
  });
  assert.deepEqual(result, { ok: true, text: "  const y = 2;\n" });
});

test("parseCompletionResponse rejects malformed payloads", () => {
  const malformed: unknown[] = [
    undefined,
    null,
    "text",
    42,
    {},
    { choices: [] },
    { choices: "nope" },
    { choices: [null] },
    { choices: [{ text: 7 }] },
    { choices: [{ index: 0 }] },
  ];
  for (const payload of malformed) {
    assert.deepEqual(parseCompletionResponse(payload), { ok: false, reason: "malformed" });
  }
});

test("parseCompletionResponse rejects empty or whitespace suggestions", () => {
  for (const text of ["", "   ", "\n\n  ", "\r\n\t"]) {
    assert.deepEqual(parseCompletionResponse({ choices: [{ text }] }), {
      ok: false,
      reason: "empty",
    });
  }
});

test("parseCompletionResponse truncates oversized suggestions", () => {
  const result = parseCompletionResponse({
    choices: [{ text: "y".repeat(MAX_SUGGESTION_CHARS + 500) }],
  });
  assert.ok(result.ok);
  if (result.ok) {
    assert.equal(result.text.length, MAX_SUGGESTION_CHARS);
  }
});

test("parseCompletionResponse keeps sanitized usage counters", () => {
  const result = parseCompletionResponse({
    choices: [{ text: "done" }],
    usage: {
      prompt_tokens: 40,
      completion_tokens: 8,
      total_tokens: 48,
      estimated: true,
    },
  });
  assert.deepEqual(result, {
    ok: true,
    text: "done",
    usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 },
  });
});

test("parseCompletionResponse drops invalid usage values", () => {
  const invalid: unknown[] = [
    undefined,
    null,
    "usage",
    7,
    {},
    { estimated: true },
    { prompt_tokens: -1, completion_tokens: "8", total_tokens: 1.5 },
    { prompt_tokens: Number.NaN },
    { prompt_tokens: Number.MAX_SAFE_INTEGER + 1 },
  ];
  for (const usage of invalid) {
    assert.equal(parseCompletionUsage(usage), undefined);
  }
  assert.deepEqual(
    parseCompletionResponse({ choices: [{ text: "done" }], usage: { prompt_tokens: -1 } }),
    { ok: true, text: "done" },
  );
  assert.deepEqual(parseCompletionUsage({ prompt_tokens: 3, completion_tokens: "nope" }), {
    prompt_tokens: 3,
  });
});

test("recordCompletionUsage adds one request and its token counts to local history", async () => {
  const calls: Array<{ modelId: string; usage: OpenAIUsage | undefined }> = [];
  let history: DailyUsage[] = [];
  const tracker = {
    record: async (modelId: string, usage: OpenAIUsage | undefined) => {
      calls.push({ modelId, usage });
      history = addUsage(history, modelId, usage, "2026-09-24");
    },
  };
  const outcome: CompletionOutcome = {
    ok: true,
    text: "secret suggestion text",
    usage: { prompt_tokens: 4_000, completion_tokens: 64 },
  };

  assert.equal(await recordCompletionUsage(tracker, "glm5.3-flash", outcome), true);
  assert.deepEqual(calls, [
    { modelId: "glm5.3-flash", usage: { prompt_tokens: 4_000, completion_tokens: 64 } },
  ]);
  assert.deepEqual(history, [
    {
      date: "2026-09-24",
      modelId: "glm5.3-flash",
      requests: 1,
      promptTokens: 4_000,
      completionTokens: 64,
    },
  ]);
  assert.equal(JSON.stringify(calls).includes("secret suggestion text"), false);
});

test("recordCompletionUsage skips cancelled, failed, and usage-less responses", async () => {
  const calls: string[] = [];
  const tracker = {
    record: async (modelId: string) => {
      calls.push(modelId);
    },
  };
  const outcomes: CompletionOutcome[] = [
    { ok: false, reason: "cancelled" },
    { ok: false, reason: "http", status: 429 },
    { ok: false, reason: "network" },
    { ok: false, reason: "malformed" },
    { ok: false, reason: "empty" },
    { ok: false, reason: "too_large" },
    { ok: true, text: "no usage reported" },
  ];

  for (const outcome of outcomes) {
    // oxlint-disable-next-line eslint/no-await-in-loop
    assert.equal(await recordCompletionUsage(tracker, "m", outcome), false);
  }
  assert.deepEqual(calls, []);
});

test("recordCompletionUsage reports false when the recorder fails", async () => {
  const tracker = {
    record: async () => {
      throw new Error("storage unavailable");
    },
  };
  assert.equal(
    await recordCompletionUsage(tracker, "m", {
      ok: true,
      text: "done",
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
    false,
  );
});

test("parseCompletionResponse rejects suggestions that are whitespace-only after truncation", () => {
  const text = " ".repeat(MAX_SUGGESTION_CHARS + 100) + "code();";
  assert.deepEqual(parseCompletionResponse({ choices: [{ text }] }), {
    ok: false,
    reason: "empty",
  });
});

test("requestInlineCompletion posts a bounded payload to {base}/completions", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const fetchImpl = ((url: RequestInfo | URL, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedInit = init;
    return Promise.resolve(jsonResponse({ choices: [{ text: "done" }] }));
  }) as unknown as typeof fetch;

  const outcome = await requestInlineCompletion({
    baseUrl: "https://api.example.com/v1/",
    apiKey: "sk-test",
    userAgent: "nan-vscode/test VSCode/test",
    request: { model: "glm5.3-flash", prompt: "const ", max_tokens: 64, temperature: 0 },
    fetchImpl,
  });

  assert.deepEqual(outcome, { ok: true, text: "done" });
  assert.equal(capturedUrl, "https://api.example.com/v1/completions");
  const headers = new Headers(capturedInit?.headers);
  assert.equal(headers.get("Authorization"), "Bearer sk-test");
  assert.equal(headers.get("Content-Type"), "application/json");
  assert.equal(headers.get("User-Agent"), "nan-vscode/test VSCode/test");
  assert.equal(capturedInit?.method, "POST");
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    model: "glm5.3-flash",
    prompt: "const ",
    max_tokens: 64,
    temperature: 0,
  });
});

test("requestInlineCompletion retries once without suffix and remembers the model", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    return "suffix" in body
      ? jsonResponse({ error: { message: "Unsupported parameter: suffix" } }, 400)
      : jsonResponse({ choices: [{ text: "done" }] });
  }) as unknown as typeof fetch;
  const suffixSupport = createCompletionSuffixSupport();
  const options = {
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-test",
    userAgent: "test",
    request: {
      model: "glm5.3-flash",
      prompt: "const ",
      suffix: "value = 1;",
      max_tokens: 64,
      temperature: 0,
    },
    suffixSupport,
    fetchImpl,
  };

  assert.deepEqual(await requestInlineCompletion(options), { ok: true, text: "done" });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].suffix, "value = 1;");
  assert.equal("suffix" in bodies[1], false);
  assert.equal(suffixSupport.supports("glm5.3-flash"), false);

  bodies.length = 0;
  assert.deepEqual(await requestInlineCompletion(options), { ok: true, text: "done" });
  assert.equal(bodies.length, 1);
  assert.equal("suffix" in bodies[0], false);
});

test("requestInlineCompletion does not blame the suffix when the retry also fails", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return jsonResponse({}, 400);
  }) as unknown as typeof fetch;
  const suffixSupport = createCompletionSuffixSupport();

  const outcome = await requestInlineCompletion({
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-test",
    userAgent: "test",
    request: {
      model: "glm5.3-flash",
      prompt: "const ",
      suffix: "value = 1;",
      max_tokens: 64,
      temperature: 0,
    },
    suffixSupport,
    fetchImpl,
  });

  assert.deepEqual(outcome, { ok: false, reason: "http", status: 400 });
  assert.equal(calls, 2);
  assert.equal(suffixSupport.supports("glm5.3-flash"), true);
});

test("requestInlineCompletion trims a suggestion that repeats the suffix start", async () => {
  const respond = (text: string) =>
    (() => Promise.resolve(jsonResponse({ choices: [{ text }] }))) as unknown as typeof fetch;
  const options = {
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-test",
    userAgent: "test",
    request: {
      model: "glm5.3-flash",
      prompt: "function f() { return ",
      suffix: "total_balance;\n}",
      max_tokens: 64,
      temperature: 0,
    },
  };

  assert.deepEqual(await requestInlineCompletion({ ...options, fetchImpl: respond("return total") }), {
    ok: true,
    text: "return ",
  });
  assert.deepEqual(
    await requestInlineCompletion({ ...options, fetchImpl: respond("total_balance;\n}") }),
    { ok: false, reason: "empty" },
  );
});

test("requestInlineCompletion surfaces the usage reported with a suggestion", async () => {
  const fetchImpl = (() =>
    Promise.resolve(
      jsonResponse({
        choices: [{ text: "suggestion" }],
        usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
      }),
    )) as unknown as typeof fetch;

  const outcome = await requestInlineCompletion({
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-test",
    userAgent: "test",
    request: { model: "qwen3.8-flash", prompt: "const ", max_tokens: 64, temperature: 0 },
    fetchImpl,
  });

  assert.deepEqual(outcome, {
    ok: true,
    text: "suggestion",
    usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
  });
});

test("requestInlineCompletion omits usage when the response has none", async () => {
  const fetchImpl = (() =>
    Promise.resolve(jsonResponse({ choices: [{ text: "suggestion" }] }))) as unknown as typeof fetch;

  const outcome = await requestInlineCompletion({
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-test",
    userAgent: "test",
    request: { model: "qwen3.8-flash", prompt: "const ", max_tokens: 64, temperature: 0 },
    fetchImpl,
  });

  assert.equal(outcome.ok, true);
  assert.equal("usage" in outcome, false);
});

test("requestInlineCompletion does not send the API key when endpoint authorization is canceled", async () => {
  let fetchCalls = 0;
  const outcome = await requestInlineCompletion({
    baseUrl: "http://api.example.test/v1",
    apiKey: "test-key",
    userAgent: "test",
    request: { model: "m", prompt: "p", max_tokens: 64, temperature: 0 },
    endpointAuthorizer: {
      authorize: async () => {
        const error = new Error("User canceled endpoint confirmation.");
        error.name = "AbortError";
        throw error;
      },
    },
    fetchImpl: (async () => {
      fetchCalls += 1;
      return jsonResponse({ choices: [{ text: "should not be sent" }] });
    }) as typeof fetch,
  });

  assert.deepEqual(outcome, { ok: false, reason: "cancelled" });
  assert.equal(fetchCalls, 0);
});

test("requestInlineCompletion keeps the confirmed endpoint when configuration changes during authorization", async () => {
  const options = {
    baseUrl: "http://confirmed.example.test/v1",
    apiKey: "test-key",
    userAgent: "test",
    request: { model: "m", prompt: "p", max_tokens: 64, temperature: 0 },
  };
  let releaseAuthorization!: () => void;
  let authorizedBaseUrl = "";
  let requestedUrl = "";
  const authorizationPending = new Promise<void>((resolve) => {
    releaseAuthorization = resolve;
  });
  const requestOptions = {
    ...options,
    endpointAuthorizer: {
      authorize: async (baseUrl: string) => {
        authorizedBaseUrl = baseUrl;
        await authorizationPending;
      },
    },
    fetchImpl: async (url: RequestInfo | URL) => {
      requestedUrl = String(url);
      return jsonResponse({ choices: [{ text: "done" }] });
    },
  };
  const completion = requestInlineCompletion(requestOptions);

  requestOptions.baseUrl = "http://changed.example.test/v1";
  releaseAuthorization();
  assert.deepEqual(await completion, { ok: true, text: "done" });
  assert.equal(authorizedBaseUrl, "http://confirmed.example.test/v1");
  assert.equal(requestedUrl, "http://confirmed.example.test/v1/completions");
});

test("requestInlineCompletion maps HTTP failures without throwing", async () => {
  const cases: Array<[number, number]> = [
    [429, 429],
    [400, 400],
    [500, 500],
  ];
  for (const [status, expected] of cases) {
      // oxlint-disable-next-line eslint/no-await-in-loop
      const fetchImpl = (() => Promise.resolve(jsonResponse({}, status))) as unknown as typeof fetch;
      // oxlint-disable-next-line eslint/no-await-in-loop
      const outcome = await requestInlineCompletion({
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-test",
      userAgent: "test",
      request: { model: "m", prompt: "p", max_tokens: 64, temperature: 0 },
      fetchImpl,
    });
    assert.deepEqual(outcome, { ok: false, reason: "http", status: expected });
  }
});

test("requestInlineCompletion cancels the response body on HTTP failures", async () => {
  let cancelled = false;
  const cancelling = {
    ok: false,
    status: 503,
    body: {
      cancel: () => {
        cancelled = true;
        return Promise.resolve();
      },
    },
  } as unknown as Response;
  const fetchImpl = (() => Promise.resolve(cancelling)) as unknown as typeof fetch;
  const outcome = await requestInlineCompletion({
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-test",
    userAgent: "test",
    request: { model: "m", prompt: "p", max_tokens: 64, temperature: 0 },
    fetchImpl,
  });
  assert.deepEqual(outcome, { ok: false, reason: "http", status: 503 });
  assert.equal(cancelled, true);

  const locked = {
    ok: false,
    status: 400,
    body: { cancel: () => Promise.reject(new Error("locked")) },
  } as unknown as Response;
  const lockedFetch = (() => Promise.resolve(locked)) as unknown as typeof fetch;
  const lockedOutcome = await requestInlineCompletion({
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-test",
    userAgent: "test",
    request: { model: "m", prompt: "p", max_tokens: 64, temperature: 0 },
    fetchImpl: lockedFetch,
  });
  assert.deepEqual(lockedOutcome, { ok: false, reason: "http", status: 400 });
});

test("requestInlineCompletion reports cancelled when already aborted without fetching", async () => {
  let called = false;
  const fetchImpl = (() => {
    called = true;
    return Promise.resolve(jsonResponse({}));
  }) as unknown as typeof fetch;
  const controller = new AbortController();
  controller.abort();

  const outcome = await requestInlineCompletion({
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-test",
    userAgent: "test",
    request: { model: "m", prompt: "p", max_tokens: 64, temperature: 0 },
    signal: controller.signal,
    fetchImpl,
  });

  assert.deepEqual(outcome, { ok: false, reason: "cancelled" });
  assert.equal(called, false);
});

test("requestInlineCompletion reports cancelled when aborted mid-flight", async () => {
  const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as unknown as typeof fetch;
  const controller = new AbortController();

  const pending = requestInlineCompletion({
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-test",
    userAgent: "test",
    request: { model: "m", prompt: "p", max_tokens: 64, temperature: 0 },
    signal: controller.signal,
    fetchImpl,
  });
  controller.abort();

  assert.deepEqual(await pending, { ok: false, reason: "cancelled" });
});

test("requestInlineCompletion maps network errors and malformed bodies", async () => {
  const network = (() => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch;
  const networkOutcome = await requestInlineCompletion({
    baseUrl: "https://api.example.com/v1",
    apiKey: "k",
    userAgent: "test",
    request: { model: "m", prompt: "p", max_tokens: 64, temperature: 0 },
    fetchImpl: network,
  });
  assert.deepEqual(networkOutcome, { ok: false, reason: "network" });

  const notJson = (() =>
    Promise.resolve(
      new Response("<html>oops</html>", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )) as unknown as typeof fetch;
  const malformedOutcome = await requestInlineCompletion({
    baseUrl: "https://api.example.com/v1",
    apiKey: "k",
    userAgent: "test",
    request: { model: "m", prompt: "p", max_tokens: 64, temperature: 0 },
    fetchImpl: notJson,
  });
  assert.deepEqual(malformedOutcome, { ok: false, reason: "malformed" });
});

test("requestInlineCompletion rejects oversized JSON without exposing its body", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        controller.enqueue(new Uint8Array(MAX_JSON_RESPONSE_BYTES + 1));
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const fetchImpl = (() => Promise.resolve(new Response(body))) as unknown as typeof fetch;
  const outcome = await requestInlineCompletion({
    baseUrl: "https://api.example.com/v1",
    apiKey: "k",
    userAgent: "test",
    request: { model: "m", prompt: "p", max_tokens: 64, temperature: 0 },
    fetchImpl,
  });
  assert.deepEqual(outcome, { ok: false, reason: "too_large" });
  assert.equal(cancelled, true);
});

test("requestInlineCompletion waits for a free slot before fetching", async () => {
  const slotQueues = new SlotQueueRegistry(1);
  let inFlight = 0;
  let peakInFlight = 0;
  const fetchImpl = (async () => {
    inFlight += 1;
    peakInFlight = Math.max(peakInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return jsonResponse({ choices: [{ text: "ok" }] });
  }) as unknown as typeof fetch;
  const options = {
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-test",
    userAgent: "test",
    request: { model: "m", prompt: "p", max_tokens: 64, temperature: 0 },
    fetchImpl,
    slotQueues,
  };

  const outcomes = await Promise.all([requestInlineCompletion(options), requestInlineCompletion(options)]);

  assert.deepEqual(outcomes[0], { ok: true, text: "ok" });
  assert.deepEqual(outcomes[1], { ok: true, text: "ok" });
  assert.equal(peakInFlight, 1);
  assert.equal(slotQueues.forCredential(credentialId("sk-test")).inUse, 0);
});

test("requestInlineCompletion cancelled while queued never fetches", async () => {
  const slotQueues = new SlotQueueRegistry(1);
  const held = await slotQueues.acquire("sk-test");
  let fetches = 0;
  const fetchImpl = (() => {
    fetches += 1;
    return Promise.resolve(jsonResponse({ choices: [{ text: "ok" }] }));
  }) as unknown as typeof fetch;
  const controller = new AbortController();

  const pending = requestInlineCompletion({
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-test",
    userAgent: "test",
    request: { model: "m", prompt: "p", max_tokens: 64, temperature: 0 },
    signal: controller.signal,
    fetchImpl,
    slotQueues,
  });
  controller.abort();

  assert.deepEqual(await pending, { ok: false, reason: "cancelled" });
  assert.equal(fetches, 0);
  held.release();
});

test("requestInlineCompletion releases its slot after HTTP and network failures", async () => {
  const slotQueues = new SlotQueueRegistry(1);
  const options = {
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-test",
    userAgent: "test",
    request: { model: "m", prompt: "p", max_tokens: 64, temperature: 0 },
  };
  const queue = slotQueues.forCredential(credentialId("sk-test"));

  const tooMany = (() =>
    Promise.resolve(jsonResponse({ error: "rate limited" }, 429))) as unknown as typeof fetch;
  assert.deepEqual(await requestInlineCompletion({ ...options, fetchImpl: tooMany, slotQueues }), {
    ok: false,
    reason: "http",
    status: 429,
  });
  assert.equal(queue.inUse, 0);

  const offline = (() => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch;
  assert.deepEqual(await requestInlineCompletion({ ...options, fetchImpl: offline, slotQueues }), {
    ok: false,
    reason: "network",
  });
  assert.equal(queue.inUse, 0);
  assert.equal(queue.pending, 0);
});

