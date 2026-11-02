import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import type * as vscode from "vscode";
import { MAX_ERROR_RESPONSE_BYTES, MAX_JSON_RESPONSE_BYTES, ResponseTooLargeError } from "../src/responseBody";
import { MAX_SSE_LINE_CHARS, StreamLimitError } from "../src/openai/stream";

type ModuleLoader = {
  _load: (request: string, parent: NodeJS.Module | null, isMain: boolean) => unknown;
};

class FakeEventEmitter {
  readonly event = () => ({ dispose: () => undefined });

  fire(): void {}

  dispose(): void {}
}

class FakeLanguageModelTextPart {
  constructor(readonly value: string) {}
}

class FakeLanguageModelToolCallPart {
  constructor(
    readonly callId: string,
    readonly name: string,
    readonly input: Record<string, unknown>,
  ) {}
}

const moduleRequire = createRequire(__filename);
const moduleLoader = moduleRequire("node:module") as ModuleLoader;
const originalLoad = moduleLoader._load;
const settings = new Map<string, unknown>();
const vscodeStub = {
  EventEmitter: FakeEventEmitter,
  extensions: { getExtension: () => undefined },
  LanguageModelChatMessageRole: { User: 1, Assistant: 2 },
  LanguageModelChatToolMode: { Auto: 1, Required: 2 },
  LanguageModelTextPart: FakeLanguageModelTextPart,
  LanguageModelToolCallPart: FakeLanguageModelToolCallPart,
  version: "test",
  window: { showInputBox: async () => undefined },
  workspace: {
    getConfiguration: () => ({
      get: (key: string, defaultValue: unknown) => settings.get(key) ?? defaultValue,
    }),
  },
};

moduleLoader._load = (request, parent, isMain) =>
  request === "vscode" ? vscodeStub : originalLoad.call(moduleLoader, request, parent, isMain);

let NanChatModelProvider: typeof import("../src/provider").NanChatModelProvider;
try {
  ({ NanChatModelProvider } = moduleRequire("../src/provider") as typeof import("../src/provider"));
} finally {
  moduleLoader._load = originalLoad;
}

class TestCancellationToken implements vscode.CancellationToken {
  isCancellationRequested = false;
  private readonly listeners = new Set<(event: void) => unknown>();

  readonly onCancellationRequested: vscode.Event<void> = (listener) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  cancel(): void {
    this.isCancellationRequested = true;
    for (const listener of this.listeners) {
      listener(undefined);
    }
  }
}

function createHarness(fetcher: typeof fetch) {
  settings.clear();
  settings.set("apiBaseUrl", "https://unit.test/v1/");
  settings.set("includeUnknownModels", false);
  settings.set("modelCacheSeconds", 300);
  const calls: string[] = [];
  let recordedUsage = 0;
  globalThis.fetch = async (input, init) => {
    calls.push(String(input));
    return fetcher(input, init);
  };
  const secrets: vscode.SecretStorage = {
    keys: async () => ["NaN_API_KEY"],
    get: async () => "unit-test-key",
    store: async () => undefined,
    delete: async () => undefined,
    onDidChange: () => ({ dispose: () => undefined }),
  };
  const provider = new NanChatModelProvider(
    { secrets },
    {
      record: async () => {
        recordedUsage += 1;
      },
    },
    { authorize: async () => undefined },
  );
  return { provider, calls, get recordedUsage() { return recordedUsage; } };
}

function modelListResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), init);
}

function oversizedResponse(byteLength: number, status = 200): { response: Response; wasCancelled: () => boolean } {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        controller.enqueue(new Uint8Array(byteLength));
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { response: new Response(body, { status }), wasCancelled: () => cancelled };
}

async function discoverChatModel(provider: InstanceType<typeof NanChatModelProvider>) {
  const [model] = await provider.provideLanguageModelChatInformation({ silent: true }, new TestCancellationToken());
  assert.ok(model);
  return model;
}

function findByteSequence(bytes: Uint8Array, sequence: Uint8Array): number {
  for (let index = 0; index <= bytes.length - sequence.length; index += 1) {
    if (sequence.every((byte, offset) => bytes[index + offset] === byte)) {
      return index;
    }
  }
  return -1;
}

function chatProgress(reported: unknown[]): vscode.Progress<vscode.LanguageModelResponsePart> {
  return { report: (part) => reported.push(part) };
}

test("model discovery caches results and refresh invalidates them after a setting change", async () => {
  const originalFetch = globalThis.fetch;
  const harness = createHarness(async () =>
    modelListResponse({ data: [{ id: "mimo-v2.6-flash" }, { id: "future-chat-model" }] }),
  );
  try {
    const token = new TestCancellationToken();
    const knownOnly = await harness.provider.provideLanguageModelChatInformation({ silent: true }, token);
    const cacheHit = await harness.provider.provideLanguageModelChatInformation({ silent: true }, token);
    assert.deepEqual(knownOnly.map((model) => model.id), ["mimo-v2.6-flash"]);
    assert.equal(cacheHit, knownOnly);
    assert.deepEqual(harness.calls, ["https://unit.test/v1/models"]);

    settings.set("includeUnknownModels", true);
    harness.provider.refresh();
    const includingUnknown = await harness.provider.provideLanguageModelChatInformation({ silent: true }, token);
    assert.deepEqual(includingUnknown.map((model) => model.id), ["mimo-v2.6-flash", "future-chat-model"]);
    assert.equal(harness.calls.length, 2);
  } finally {
    harness.provider.dispose();
    globalThis.fetch = originalFetch;
  }
});

test("malformed and unsuccessful model responses reject discovery with useful errors", async (t) => {
  const originalFetch = globalThis.fetch;
  const cases: Array<{ name: string; response: () => Response; message: RegExp }> = [
    {
      name: "malformed JSON",
      response: () => new Response("{", { status: 200 }),
      message: /JSON|unexpected/i,
    },
    {
      name: "other HTTP failure",
      response: () => new Response("unavailable", { status: 503, statusText: "Service Unavailable" }),
      message: /HTTP 503 Service Unavailable/,
    },
    ...[401, 403].map((status) => ({
      name: `HTTP ${status} key guidance`,
      response: () => new Response("", { status }),
      message: /rejected the API key.*Manage Provider/,
    })),
  ];

  try {
    for (const testCase of cases) {
      await t.test(testCase.name, async () => {
        const harness = createHarness(async () => testCase.response());
        try {
          await assert.rejects(
            harness.provider.provideLanguageModelChatInformation({ silent: true }, new TestCancellationToken()),
            testCase.message,
          );
          assert.equal(harness.calls.length, 1);
        } finally {
          harness.provider.dispose();
        }
      });
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("model discovery rejects oversized JSON with a stable error and cancels the body", async () => {
  const originalFetch = globalThis.fetch;
  const oversized = oversizedResponse(MAX_JSON_RESPONSE_BYTES + 1);
  const harness = createHarness(async () => oversized.response);
  try {
    await assert.rejects(
      harness.provider.provideLanguageModelChatInformation({ silent: true }, new TestCancellationToken()),
      (error: unknown) =>
        error instanceof ResponseTooLargeError &&
        error.message === "Upstream response exceeded the maximum allowed size." &&
        !error.message.includes("A".repeat(32)),
    );
    assert.equal(oversized.wasCancelled(), true);
  } finally {
    harness.provider.dispose();
    globalThis.fetch = originalFetch;
  }
});

test("cancellation before discovery avoids credentials and fetch", async () => {
  const originalFetch = globalThis.fetch;
  const harness = createHarness(async () => modelListResponse({ data: [] }));
  const token = new TestCancellationToken();
  token.cancel();
  try {
    assert.deepEqual(await harness.provider.provideLanguageModelChatInformation({ silent: true }, token), []);
    assert.deepEqual(harness.calls, []);
  } finally {
    harness.provider.dispose();
    globalThis.fetch = originalFetch;
  }
});

test("cancellation aborts an in-flight model request", async () => {
  const originalFetch = globalThis.fetch;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const harness = createHarness(
    (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            const error = new Error("Request aborted");
            error.name = "AbortError";
            reject(error);
          },
          { once: true },
        );
        markStarted();
      }),
  );
  const token = new TestCancellationToken();
  try {
    const result = harness.provider.provideLanguageModelChatInformation({ silent: true }, token);
    await started;
    token.cancel();
    assert.deepEqual(await result, []);
    assert.equal(harness.calls.length, 1);
  } finally {
    harness.provider.dispose();
    globalThis.fetch = originalFetch;
  }
});

test("chat finalization emits a multibyte character split across response chunks", async () => {
  const originalFetch = globalThis.fetch;
  const originalTextDecoder = globalThis.TextDecoder;
  let finalFlushCount = 0;
  class TrackingTextDecoder extends originalTextDecoder {
    override decode(input?: AllowSharedBufferSource, options?: TextDecodeOptions): string {
      if (input === undefined) {
        finalFlushCount += 1;
      }
      return super.decode(input, options);
    }
  }

  const line = `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello 世界" } }] })}\n`;
  const encoded = new TextEncoder().encode(line);
  const characterBytes = new TextEncoder().encode("世");
  const characterStart = findByteSequence(encoded, characterBytes);
  assert.ok(characterStart >= 0);
  const splitAt = characterStart + 1;
  const responseBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded.slice(0, splitAt));
      controller.enqueue(encoded.slice(splitAt));
      controller.close();
    },
  });
  const harness = createHarness(async (input) =>
    String(input).endsWith("/models")
      ? modelListResponse({ data: [{ id: "mimo-v2.6-flash" }] })
      : new Response(responseBody),
  );
  const reported: unknown[] = [];
  try {
    const model = await discoverChatModel(harness.provider);
    globalThis.TextDecoder = TrackingTextDecoder;
    await harness.provider.provideLanguageModelChatResponse(
      model,
      [],
      { toolMode: 1 as vscode.LanguageModelChatToolMode },
      chatProgress(reported),
      new TestCancellationToken(),
    );
    assert.deepEqual(reported, [new FakeLanguageModelTextPart("Hello 世界")]);
    assert.equal(finalFlushCount, 1);
    assert.equal(harness.recordedUsage, 1);
  } finally {
    harness.provider.dispose();
    globalThis.fetch = originalFetch;
    globalThis.TextDecoder = originalTextDecoder;
  }
});

test("chat cancellation skips final text and tool events buffered in the SSE decoder", async (t) => {
  const originalFetch = globalThis.fetch;
  const cases = [
    {
      name: "partial text",
      payload: { choices: [{ delta: { content: "partial text" } }] },
    },
    {
      name: "partial tool arguments",
      payload: {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  function: { name: "read_file", arguments: '{"path":"README.md"}' },
                },
              ],
            },
          },
        ],
      },
    },
  ];

  try {
    for (const testCase of cases) {
      await t.test(testCase.name, async () => {
        let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
        let resolveNextRead!: () => void;
        const nextRead = new Promise<void>((resolve) => {
          resolveNextRead = resolve;
        });
        let pulls = 0;
        const harness = createHarness(async (input, init) => {
          if (String(input).endsWith("/models")) {
            return modelListResponse({ data: [{ id: "mimo-v2.6-flash" }] });
          }

          const responseBody = new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                streamController = controller;
                pulls += 1;
                if (pulls === 1) {
                  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(testCase.payload)}`));
                } else {
                  resolveNextRead();
                }
              },
            },
            { highWaterMark: 0 },
          );
          init?.signal?.addEventListener(
            "abort",
            () => {
              streamController?.close();
            },
            { once: true },
          );
          return new Response(responseBody);
        });
        const reported: unknown[] = [];
        try {
          const model = await discoverChatModel(harness.provider);
          const token = new TestCancellationToken();
          const response = harness.provider.provideLanguageModelChatResponse(
            model,
            [],
            { toolMode: 1 as vscode.LanguageModelChatToolMode },
            chatProgress(reported),
            token,
          );
          await nextRead;
          token.cancel();
          await response;
          assert.deepEqual(reported, []);
          assert.equal(harness.recordedUsage, 0);
        } finally {
          harness.provider.dispose();
        }
      });
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("chat rejects oversized HTTP error text with a stable error and cancels the body", async () => {
  const originalFetch = globalThis.fetch;
  const oversized = oversizedResponse(MAX_ERROR_RESPONSE_BYTES + 1, 400);
  const harness = createHarness(async (input) =>
    String(input).endsWith("/models") ? modelListResponse({ data: [{ id: "mimo-v2.6-flash" }] }) : oversized.response,
  );
  try {
    const model = await discoverChatModel(harness.provider);
    await assert.rejects(
      harness.provider.provideLanguageModelChatResponse(
        model,
        [],
        { toolMode: 1 as vscode.LanguageModelChatToolMode },
        chatProgress([]),
        new TestCancellationToken(),
      ),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("API error 400") &&
        !error.message.includes("A".repeat(32)),
    );
    assert.equal(oversized.wasCancelled(), true);
  } finally {
    harness.provider.dispose();
    globalThis.fetch = originalFetch;
  }
});

test("chat cancels the upstream stream when an unterminated SSE line exceeds its limit", async () => {
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(MAX_SSE_LINE_CHARS + 1)));
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const harness = createHarness(async (input) =>
    String(input).endsWith("/models") ? modelListResponse({ data: [{ id: "mimo-v2.6-flash" }] }) : new Response(body),
  );
  try {
    const model = await discoverChatModel(harness.provider);
    await assert.rejects(
      harness.provider.provideLanguageModelChatResponse(
        model,
        [],
        { toolMode: 1 as vscode.LanguageModelChatToolMode },
        chatProgress([]),
        new TestCancellationToken(),
      ),
      (error: unknown) =>
        error instanceof StreamLimitError &&
        error.kind === "line" &&
        error.message === "NaN Builders chat stream exceeded the maximum SSE line size.",
    );
    assert.equal(cancelled, true);
  } finally {
    harness.provider.dispose();
    globalThis.fetch = originalFetch;
  }
});
