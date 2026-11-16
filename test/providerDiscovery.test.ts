import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import type * as vscode from "vscode";
import { SECRET_API_KEY } from "../src/constants";
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
  CancellationTokenSource: class {
    token = new TestCancellationToken();
    dispose(): void {
      /* no-op for unit tests */
    }
  },
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

test("discoveryMode auto exposes bare third-party IDs and hides non-chat endpoints", async () => {
  const originalFetch = globalThis.fetch;
  const harness = createHarness(async () =>
    modelListResponse({
      data: [{ id: "mimo-v2.6-flash" }, { id: "future-chat-model" }, { id: "bge-m3-embedding" }],
    }),
  );
  try {
    settings.set("discoveryMode", "auto");
    const models = await harness.provider.provideLanguageModelChatInformation(
      { silent: true },
      new TestCancellationToken(),
    );
    assert.deepEqual(models.map((model) => model.id).sort(), ["future-chat-model", "mimo-v2.6-flash"]);
    const discovered = models.find((model) => model.id === "future-chat-model");
    assert.ok(discovered);
    assert.equal(discovered.capabilities?.toolCalling, false);
    assert.match(String(discovered.tooltip), /Auto-discovered from the configured endpoint/);
  } finally {
    harness.provider.dispose();
    globalThis.fetch = originalFetch;
  }
});

test("malformed and unsuccessful model responses fall back to the static unverified catalog", async (t) => {
  const originalFetch = globalThis.fetch;
  const cases: Array<{ name: string; response: () => Response }> = [
    { name: "malformed JSON", response: () => new Response("{", { status: 200 }) },
    { name: "other HTTP failure", response: () => new Response("unavailable", { status: 503, statusText: "Service Unavailable" }) },
    { name: "HTTP 401", response: () => new Response("", { status: 401 }) },
    { name: "HTTP 403", response: () => new Response("", { status: 403 }) },
  ];

  try {
    for (const testCase of cases) {
        // oxlint-disable-next-line eslint/no-await-in-loop
        await t.test(testCase.name, async () => {
          const harness = createHarness(async () => testCase.response());
          try {
            // oxlint-disable-next-line eslint/no-await-in-loop
            const models = await harness.provider.provideLanguageModelChatInformation(
              { silent: true },
              new TestCancellationToken(),
            );
            assert.ok(models.length >= 1);
            assert.equal(models[0]!.detail, "NaN Builders - not live-verified");
            assert.match(String(models[0]!.tooltip), /Static NaN Builders catalog .* not verified/i);
            assert.ok(models.some((model) => model.id === "glm5.3-flash"));
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

test("empty chat model lists fall back to the static catalog only in curated mode", async () => {
  const originalFetch = globalThis.fetch;
  const harness = createHarness(async () =>
    modelListResponse({ data: [{ id: "bge-m3-embedding" }, { id: "mimo-v2.6-flash", is_chat: false }] }),
  );
  try {
    const curated = await harness.provider.provideLanguageModelChatInformation(
      { silent: true },
      new TestCancellationToken(),
    );
    assert.ok(curated.some((model) => model.id === "glm5.3-flash"));
    assert.equal(curated[0]!.detail, "NaN Builders - not live-verified");

    harness.provider.refresh();
    settings.set("discoveryMode", "auto");
    const auto = await harness.provider.provideLanguageModelChatInformation(
      { silent: true },
      new TestCancellationToken(),
    );
    assert.deepEqual(auto, []);
  } finally {
    harness.provider.dispose();
    globalThis.fetch = originalFetch;
  }
});

test("validateConfiguredKey still surfaces discovery errors for the manage command", async () => {
  const originalFetch = globalThis.fetch;
  const harness = createHarness(async () => new Response("", { status: 401 }));
  try {
    await assert.rejects(harness.provider.validateConfiguredKey(), /rejected the API key/);
  } finally {
    harness.provider.dispose();
    globalThis.fetch = originalFetch;
  }
});

test("advertised input budget reserves a 10 percent tokenizer margin", async () => {
  const originalFetch = globalThis.fetch;
  const harness = createHarness(async () =>
    modelListResponse({
      data: [
        { id: "mimo-v2.6-flash" },
        { id: "gemma4" },
        { id: "third-party", context_window: 1000, max_output_tokens: 50 },
      ],
    }),
  );
  try {
    settings.set("includeUnknownModels", true);
    const models = await harness.provider.provideLanguageModelChatInformation(
      { silent: true },
      new TestCancellationToken(),
    );
    const byId = new Map(models.map((model) => [model.id, model]));
    // context - output (1,015,808) exceeds 0.9x context -> budget wins.
    assert.equal(byId.get("mimo-v2.6-flash")!.maxInputTokens, Math.floor(1_048_576 * 0.9));
    // context - output (196,608) is below 0.9x context (235,929) -> output size wins.
    assert.equal(byId.get("gemma4")!.maxInputTokens, 262_144 - 65_536);
    assert.equal(byId.get("third-party")!.maxInputTokens, 900);
  } finally {
    harness.provider.dispose();
    globalThis.fetch = originalFetch;
  }
});

test("model discovery rejects oversized JSON from validation but falls back in the picker", async () => {
  const originalFetch = globalThis.fetch;
  const oversized = oversizedResponse(MAX_JSON_RESPONSE_BYTES + 1);
  const harness = createHarness(async () => oversized.response);
  try {
    const models = await harness.provider.provideLanguageModelChatInformation(
      { silent: true },
      new TestCancellationToken(),
    );
    assert.equal(models[0]!.detail, "NaN Builders - not live-verified");
    assert.equal(oversized.wasCancelled(), true);

    const oversized2 = oversizedResponse(MAX_JSON_RESPONSE_BYTES + 1);
    const harness2 = createHarness(async () => oversized2.response);
    try {
      await assert.rejects(harness2.provider.validateConfiguredKey(), ResponseTooLargeError);
    } finally {
      harness2.provider.dispose();
    }
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

test("native provider configuration overrides the stored key and settings for discovery and chat", async () => {
  const originalFetch = globalThis.fetch;
  const storedSecrets = new Map<string, string>();
  const secrets: vscode.SecretStorage = {
    keys: async () => [...storedSecrets.keys()],
    get: async (key) => storedSecrets.get(key),
    store: async (key, value) => {
      storedSecrets.set(key, value);
    },
    delete: async (key) => {
      storedSecrets.delete(key);
    },
    onDidChange: () => ({ dispose: () => undefined }),
  };
  settings.clear();
  settings.set("apiBaseUrl", "https://unit.test/v1/");
  settings.set("includeUnknownModels", false);
  settings.set("modelCacheSeconds", 300);
  const calls: string[] = [];
  const authorizations: string[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push(String(input));
    const headers = init?.headers as { Authorization?: string } | undefined;
    authorizations.push(String(headers?.Authorization));
    return modelListResponse({ data: [{ id: "mimo-v2.6-flash" }] });
  };
  const provider = new NanChatModelProvider(
    { secrets },
    { record: async () => undefined },
    { authorize: async () => undefined },
  );
  try {
    const token = new TestCancellationToken();
    const configuration = { apiKey: " native-key ", apiBaseUrl: "https://native.test/v1/" };
    await provider.provideLanguageModelChatInformation({ silent: true, configuration }, token);
    assert.deepEqual(calls, ["https://native.test/v1/models"]);
    assert.equal(authorizations[0], "Bearer native-key");
    assert.equal(storedSecrets.get(SECRET_API_KEY), "native-key");

    const [model] = await provider.provideLanguageModelChatInformation({ silent: true, configuration }, token);
    assert.ok(model);
    await provider.provideLanguageModelChatResponse(
      model,
      [],
      {
        toolMode: 1 as vscode.LanguageModelChatToolMode,
        modelConfiguration: { apiKey: "request-key" },
      } as vscode.ProvideLanguageModelChatResponseOptions,
      { report: () => undefined },
      token,
    );
    assert.deepEqual(calls, ["https://native.test/v1/models", "https://native.test/v1/chat/completions"]);
    assert.equal(authorizations[1], "Bearer request-key");
  } finally {
    provider.dispose();
    globalThis.fetch = originalFetch;
  }
});

test("provider configuration changes invalidate the model cache", async () => {
  const originalFetch = globalThis.fetch;
  const harness = createHarness(async () => modelListResponse({ data: [{ id: "mimo-v2.6-flash" }] }));
  try {
    const token = new TestCancellationToken();
    await harness.provider.provideLanguageModelChatInformation({ silent: true }, token);
    await harness.provider.provideLanguageModelChatInformation({ silent: true }, token);
    assert.equal(harness.calls.length, 1);
    await harness.provider.provideLanguageModelChatInformation(
      { silent: true, configuration: { apiBaseUrl: "https://other.test/v1" } },
      token,
    );
    assert.deepEqual(harness.calls, ["https://unit.test/v1/models", "https://other.test/v1/models"]);
  } finally {
    harness.provider.dispose();
    globalThis.fetch = originalFetch;
  }
});

test("reasoning effort resolves request > per-model override > global default > model default with closest-level remapping", async () => {
  const originalFetch = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  const harness = createHarness(async (input, init) => {
    if (String(input).endsWith("/models")) {
      return modelListResponse({ data: [{ id: "glm5.3-flash" }] });
    }
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ choices: [{ delta: { content: "ok" } }] }));
  });
  try {
    const token = new TestCancellationToken();
    const model = await discoverChatModel(harness.provider);
    const send = (options: Partial<vscode.ProvideLanguageModelChatResponseOptions>) =>
      harness.provider.provideLanguageModelChatResponse(
        model,
        [],
        options as vscode.ProvideLanguageModelChatResponseOptions,
        chatProgress([]),
        token,
      );

    // auto default: "medium" exists in the GLM ladder.
    await send({});
    assert.equal(bodies[0]?.reasoning_effort, "medium");

    // Per-model override outside the documented ladder is remapped: GLM has
    // no off switch, so "none" lands on its lowest documented level.
    settings.set("reasoningEffortByModel", { "glm5.3-flash": "none" });
    await send({});
    assert.equal(bodies[1]?.reasoning_effort, "minimal");

    // The chat request wins over everything; "xhigh" is documented on GLM.
    await send({ modelOptions: { reasoning_effort: "xhigh" } });
    assert.equal(bodies[2]?.reasoning_effort, "xhigh");

    // Explicit global default applies when no override exists, remapped to the ladder.
    settings.set("reasoningEffortByModel", {});
    settings.set("defaultReasoningEffort", "minimal");
    await send({});
    assert.equal(bodies[3]?.reasoning_effort, "minimal");
  } finally {
    harness.provider.dispose();
    globalThis.fetch = originalFetch;
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
        // oxlint-disable-next-line eslint/no-await-in-loop
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
