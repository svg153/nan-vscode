import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_COMPLETION_TOKENS,
  MAX_PROMPT_CHARS,
  MAX_SUGGESTION_CHARS,
  buildCompletionRequest,
  parseCompletionResponse,
  requestInlineCompletion,
} from "../src/inlineCompletion";

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
  assert.deepEqual(Object.keys(request).sort(), ["max_tokens", "model", "prompt", "temperature"]);
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

test("requestInlineCompletion maps HTTP failures without throwing", async () => {
  const cases: Array<[number, number]> = [
    [429, 429],
    [400, 400],
    [500, 500],
  ];
  for (const [status, expected] of cases) {
    const fetchImpl = (() => Promise.resolve(jsonResponse({}, status))) as unknown as typeof fetch;
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

test("requestInlineCompletion maps empty suggestions from a valid payload", async () => {
  const fetchImpl = (() =>
    Promise.resolve(jsonResponse({ choices: [{ text: "  \n" }] }))) as unknown as typeof fetch;
  const outcome = await requestInlineCompletion({
    baseUrl: "https://api.example.com/v1",
    apiKey: "k",
    userAgent: "test",
    request: { model: "m", prompt: "p", max_tokens: 64, temperature: 0 },
    fetchImpl,
  });
  assert.deepEqual(outcome, { ok: false, reason: "empty" });
});
