import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import type * as vscode from "vscode";
import { SECRET_API_KEY } from "../src/constants";
import { RequestTimeoutError } from "../src/openai/request";
import { DEFAULT_MAX_PARALLEL_REQUESTS, SlotQueueRegistry, credentialId } from "../src/openai/slotQueue";
import { ProviderError } from "../src/providerErrors";
import { MAX_ERROR_RESPONSE_BYTES, MAX_JSON_RESPONSE_BYTES, ResponseTooLargeError } from "../src/responseBody";
import { MAX_SSE_LINE_CHARS, StreamLimitError } from "../src/openai/stream";
import {
  MAX_PERSISTED_MODEL_AGE_MS,
  PERSISTED_MODELS_KEY,
  parsePersistedModelList,
  serializeModelList,
} from "../src/modelPersistence";

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

type GlobalState = vscode.ExtensionContext["globalState"];

/** In-memory stand-in for `context.globalState`. */
class FakeMemento implements GlobalState {
  private readonly values = new Map<string, unknown>();

  keys(): readonly string[] {
    return [...this.values.keys()];
  }

  get<T>(key: string, defaultValue?: T): T | undefined {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T | undefined;
  }

  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) {
      this.values.delete(key);
    } else {
      this.values.set(key, value);
    }
    return Promise.resolve();
  }

  setKeysForSync(): void {}
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

function createHarness(
  fetcher: typeof fetch,
  endpointAuthorizer: { authorize: (baseUrl: string, signal?: AbortSignal) => Promise<void> } = {
    authorize: async () => undefined,
  },
  slots: SlotQueueRegistry = new SlotQueueRegistry(DEFAULT_MAX_PARALLEL_REQUESTS),
  globalState: GlobalState = new FakeMemento(),
) {
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
    { secrets, globalState },
    {
      record: async () => {
        recordedUsage += 1;
      },
    },
    endpointAuthorizer,
    slots,
  );
  return { provider, calls, slots, globalState, get recordedUsage() { return recordedUsage; } };
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

/** Drains pending promise continuations while `setTimeout` is faked. */
async function flushAsyncWork(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function ssePayload(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n`;
}

function chatOutcome(
  provider: InstanceType<typeof NanChatModelProvider>,
  model: vscode.LanguageModelChatInformation,
  reported: unknown[],
  token: TestCancellationToken = new TestCancellationToken(),
): Promise<unknown> {
  return provider
    .provideLanguageModelChatResponse(
      model,
      [],
      { toolMode: 1 as vscode.LanguageModelChatToolMode },
      chatProgress(reported),
      token,
    )
    .then(
      () => undefined,
      (error: unknown) => error,
    );
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

test("the last live list survives a restart and outranks the static catalog", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const first = createHarness(async () =>
      modelListResponse({ data: [{ id: "future-chat-model", is_chat: true, context_window: 200_000 }] }),
    );
    await first.provider.provideLanguageModelChatInformation({ silent: true }, new TestCancellationToken());
    assert.ok(first.globalState.get(PERSISTED_MODELS_KEY));
    first.provider.dispose();

    const second = createHarness(
      async () => new Response("unavailable", { status: 503, statusText: "Service Unavailable" }),
      undefined,
      undefined,
      first.globalState,
    );
    try {
      const models = await second.provider.provideLanguageModelChatInformation(
        { silent: true },
        new TestCancellationToken(),
      );
      assert.deepEqual(models.map((model) => model.id), ["future-chat-model"]);
      assert.equal(models[0]!.detail, "NaN Builders - not live-verified");
      assert.match(String(models[0]!.tooltip), /Last discovered .* access is not verified/i);
    } finally {
      second.provider.dispose();
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("corrupted or stale persisted lists fall back to the static catalog", async (t) => {
  const originalFetch = globalThis.fetch;
  const cases: Array<{ name: string; value: string }> = [
    { name: "corrupt JSON", value: "{" },
    {
      name: "unknown schema version",
      value: JSON.stringify({ version: 999, savedAt: Date.now(), models: [{ id: "future-chat-model" }] }),
    },
    {
      name: "stale list",
      value: serializeModelList([{ id: "future-chat-model" }], Date.now() - MAX_PERSISTED_MODEL_AGE_MS - 1),
    },
  ];

  try {
    for (const testCase of cases) {
      // oxlint-disable-next-line eslint/no-await-in-loop
      await t.test(testCase.name, async () => {
        const globalState = new FakeMemento();
        await globalState.update(PERSISTED_MODELS_KEY, testCase.value);
        const harness = createHarness(
          async () => new Response("", { status: 503 }),
          undefined,
          undefined,
          globalState,
        );
        try {
          // oxlint-disable-next-line eslint/no-await-in-loop
          const models = await harness.provider.provideLanguageModelChatInformation(
            { silent: true },
            new TestCancellationToken(),
          );
          assert.ok(models.some((model) => model.id === "glm5.3-flash"));
          assert.equal(models[0]!.detail, "NaN Builders - not live-verified");
          assert.match(String(models[0]!.tooltip), /Static NaN Builders catalog/);
          assert.ok(!models.some((model) => model.id === "future-chat-model"));
        } finally {
          harness.provider.dispose();
        }
      });
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a later successful discovery replaces the persisted list", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const first = createHarness(async () =>
      modelListResponse({ data: [{ id: "first-chat-model", is_chat: true }] }),
    );
    await first.provider.provideLanguageModelChatInformation({ silent: true }, new TestCancellationToken());
    first.provider.dispose();

    const second = createHarness(
      async () => modelListResponse({ data: [{ id: "second-chat-model", is_chat: true }] }),
      undefined,
      undefined,
      first.globalState,
    );
    try {
      await second.provider.provideLanguageModelChatInformation({ silent: true }, new TestCancellationToken());
    } finally {
      second.provider.dispose();
    }

    const persisted = parsePersistedModelList(second.globalState.get<unknown>(PERSISTED_MODELS_KEY));
    assert.deepEqual(persisted?.map((model) => model.id), ["second-chat-model"]);
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

test("discovery failures preserve the HTTP status and sanitized body identifiers", async (t) => {
  const originalFetch = globalThis.fetch;
  const cases = [
    {
      name: "HTTP 401 keeps gateway identifiers",
      status: 401,
      body: JSON.stringify({
        error: { type: "invalid_api_key", code: "bad_key", message: "Incorrect API key provided: sk-live-SENTINEL" },
      }),
      expectedDetail: "invalid_api_key bad_key",
    },
    {
      name: "HTTP 503 keeps gateway identifiers",
      status: 503,
      body: JSON.stringify({ error: { type: "server_error", code: "upstream_unavailable" } }),
      expectedDetail: "server_error upstream_unavailable",
    },
    {
      name: "non-JSON body leaves only the status",
      status: 502,
      body: "sk-live-SENTINEL",
      expectedDetail: undefined,
    },
  ];

  try {
    for (const testCase of cases) {
        // oxlint-disable-next-line eslint/no-await-in-loop
        await t.test(testCase.name, async () => {
          const harness = createHarness(async () => new Response(testCase.body, { status: testCase.status }));
          try {
            // oxlint-disable-next-line eslint/no-await-in-loop
            await assert.rejects(harness.provider.validateConfiguredKey(), new RegExp(`HTTP ${testCase.status}`));
            const failure = harness.provider.discoveryError();
            assert.equal(failure?.status, testCase.status);
            assert.equal(failure?.detail, testCase.expectedDetail);
            assert.equal(JSON.stringify(failure).includes("sk-live-SENTINEL"), false);
          } finally {
            harness.provider.dispose();
          }
        });
    }
  } finally {
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
    { secrets, globalState: new FakeMemento() },
    { record: async () => undefined },
    { authorize: async () => undefined },
    new SlotQueueRegistry(DEFAULT_MAX_PARALLEL_REQUESTS),
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

test("slow endpoint consent does not consume the response-headers deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const originalFetch = globalThis.fetch;
  let authorizeCalls = 0;
  let resolveConsent!: () => void;
  const consent = new Promise<void>((resolve) => {
    resolveConsent = resolve;
  });
  let signalAbortedAtFetch: boolean | undefined;
  const harness = createHarness(
    async (input, init) => {
      if (String(input).endsWith("/models")) {
        return modelListResponse({ data: [{ id: "mimo-v2.6-flash" }] });
      }
      signalAbortedAtFetch = init?.signal?.aborted;
      return new Response(ssePayload("ok"));
    },
    {
      authorize: () => {
        authorizeCalls += 1;
        // The consent prompt only gates the chat request, not discovery.
        return authorizeCalls === 1 ? Promise.resolve() : consent;
      },
    },
  );
  // Settings must be written after createHarness, which resets the settings map.
  settings.set("connectTimeoutSeconds", 5);
  const reported: unknown[] = [];
  try {
    const model = await discoverChatModel(harness.provider);
    const outcome = chatOutcome(harness.provider, model, reported);
    await flushAsyncWork();
    // The consent prompt stays open for longer than the whole headers deadline.
    t.mock.timers.tick(30_000);
    await flushAsyncWork();
    assert.deepEqual(harness.calls, ["https://unit.test/v1/models"]);

    resolveConsent();
    assert.equal(await outcome, undefined);
    assert.equal(signalAbortedAtFetch, false);
    assert.deepEqual(reported, [new FakeLanguageModelTextPart("ok")]);
  } finally {
    harness.provider.dispose();
    globalThis.fetch = originalFetch;
  }
});

test("the compatibility fallback gets its own response-headers deadline after a late 400", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const originalFetch = globalThis.fetch;
  const chatSignals: AbortSignal[] = [];
  const chatBodies: Record<string, unknown>[] = [];
  let resolveFirst!: (response: Response) => void;
  let resolveFallback!: (response: Response) => void;
  const firstAttempt = new Promise<Response>((resolve) => {
    resolveFirst = resolve;
  });
  const fallbackAttempt = new Promise<Response>((resolve) => {
    resolveFallback = resolve;
  });
  const harness = createHarness(async (input, init) => {
    if (String(input).endsWith("/models")) {
      return modelListResponse({ data: [{ id: "mimo-v2.6-flash" }] });
    }
    chatSignals.push(init?.signal as AbortSignal);
    chatBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return chatSignals.length === 1 ? firstAttempt : fallbackAttempt;
  });
  settings.set("connectTimeoutSeconds", 5);
  const reported: unknown[] = [];
  try {
    const model = await discoverChatModel(harness.provider);
    const outcome = chatOutcome(harness.provider, model, reported);
    await flushAsyncWork();
    assert.equal(chatSignals.length, 1);

    // The first attempt sends headers only after using 3 of its 5 seconds.
    t.mock.timers.tick(3_000);
    resolveFirst(
      new Response('{"error":{"message":"stream_options is not supported"}}', {
        status: 400,
        statusText: "Bad Request",
      }),
    );
    await flushAsyncWork();
    assert.equal(chatSignals.length, 2);
    assert.equal("stream_options" in chatBodies[1]!, false);

    // Four more seconds beat the original deadline, but leave the fallback,
    // which started its own deadline, still inside its headers window.
    t.mock.timers.tick(4_000);
    await flushAsyncWork();
    assert.equal(chatSignals[1]!.aborted, false);

    resolveFallback(new Response(ssePayload("ok")));
    assert.equal(await outcome, undefined);
    assert.deepEqual(reported, [new FakeLanguageModelTextPart("ok")]);
  } finally {
    harness.provider.dispose();
    globalThis.fetch = originalFetch;
  }
});

test("response headers end the connect deadline while a slow error body is still being read", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const originalFetch = globalThis.fetch;
  let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let chatSignal: AbortSignal | undefined;
  const harness = createHarness(async (input, init) => {
    if (String(input).endsWith("/models")) {
      return modelListResponse({ data: [{ id: "mimo-v2.6-flash" }] });
    }
    chatSignal = init?.signal as AbortSignal;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
      },
    });
    chatSignal.addEventListener("abort", () => bodyController?.error(chatSignal?.reason), { once: true });
    return new Response(body, { status: 400, statusText: "Bad Request" });
  });
  settings.set("connectTimeoutSeconds", 5);
  settings.set("streamIdleTimeoutSeconds", 30);
  const reported: unknown[] = [];
  try {
    const model = await discoverChatModel(harness.provider);
    const outcome = chatOutcome(harness.provider, model, reported);
    await flushAsyncWork();
    assert.ok(bodyController);

    // Headers arrived; only the error body is pending. Six seconds of silence
    // would report a headers timeout if the connect deadline still ran.
    t.mock.timers.tick(6_000);
    await flushAsyncWork();
    assert.equal(chatSignal!.aborted, false);

    // Because headers switched the timer to body-idle, the timeout that
    // reports this stalled body is an idle timeout, not a headers timeout.
    t.mock.timers.tick(24_001);
    await flushAsyncWork();
    const failure = await outcome;
    assert.ok(failure instanceof RequestTimeoutError);
    assert.equal(failure.kind, "stream-idle");
  } finally {
    harness.provider.dispose();
    globalThis.fetch = originalFetch;
  }
});

test("chat requests beyond the concurrency limit wait instead of racing the gateway", async () => {
  const originalFetch = globalThis.fetch;
  const slots = new SlotQueueRegistry(1);
  let inFlight = 0;
  let peakInFlight = 0;
  const harness = createHarness(async (input) => {
    if (String(input).endsWith("/models")) {
      return modelListResponse({ data: [{ id: "mimo-v2.6-flash" }] });
    }
    inFlight += 1;
    peakInFlight = Math.max(peakInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return new Response(ssePayload("hi"));
  }, undefined, slots);
  try {
    const model = await discoverChatModel(harness.provider);
    const reported: unknown[] = [];
    await Promise.all([
      chatOutcome(harness.provider, model, reported),
      chatOutcome(harness.provider, model, []),
    ]);

    assert.equal(peakInFlight, 1);
    assert.equal(harness.recordedUsage, 2);
    assert.equal(reported.length, 1);
    assert.equal(slots.forCredential(credentialId("unit-test-key")).inUse, 0);
  } finally {
    harness.provider.dispose();
    globalThis.fetch = originalFetch;
  }
});

test("chat cancelled while queued never reaches the gateway", async () => {
  const originalFetch = globalThis.fetch;
  const slots = new SlotQueueRegistry(1);
  const harness = createHarness(
    async (input) =>
      String(input).endsWith("/models")
        ? modelListResponse({ data: [{ id: "mimo-v2.6-flash" }] })
        : new Response(ssePayload("hi")),
    undefined,
    slots,
  );
  const chatCalls = (): string[] =>
    harness.calls.filter((call) => call.endsWith("/chat/completions"));
  try {
    const model = await discoverChatModel(harness.provider);
    const held = await slots.acquire("unit-test-key");
    const token = new TestCancellationToken();
    const pending = chatOutcome(harness.provider, model, [], token);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(chatCalls(), []);

    token.cancel();
    assert.equal(await pending, undefined);
    assert.deepEqual(chatCalls(), []);
    held.release();
  } finally {
    harness.provider.dispose();
    globalThis.fetch = originalFetch;
  }
});

test("a failed chat response releases its slot for the next request", async () => {
  const originalFetch = globalThis.fetch;
  const slots = new SlotQueueRegistry(1);
  let chatAttempts = 0;
  const harness = createHarness(async (input) => {
    if (String(input).endsWith("/models")) {
      return modelListResponse({ data: [{ id: "mimo-v2.6-flash" }] });
    }
    chatAttempts += 1;
    if (chatAttempts === 1) {
      // A 4xx other than an exhausted-credit 429 is never retried, so the
      // failure stays visible and this test keeps asserting slot release.
      return new Response("bad request", { status: 400 });
    }
    return new Response(ssePayload("hi"));
  }, undefined, slots);
  try {
    const model = await discoverChatModel(harness.provider);
    const failed = await chatOutcome(harness.provider, model, []);
    assert.ok(failed instanceof Error);
    assert.equal(slots.forCredential(credentialId("unit-test-key")).inUse, 0);

    const reported: unknown[] = [];
    assert.equal(await chatOutcome(harness.provider, model, reported), undefined);
    assert.equal(reported.length, 1);
    assert.equal(chatAttempts, 2);
  } finally {
    harness.provider.dispose();
    globalThis.fetch = originalFetch;
  }
});

test("retries a throttled chat request after Retry-After and streams the retried reply", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const originalFetch = globalThis.fetch;
  let chatAttempts = 0;
  const harness = createHarness(async (input) => {
    if (String(input).endsWith("/models")) {
      return modelListResponse({ data: [{ id: "mimo-v2.6-flash" }] });
    }
    chatAttempts += 1;
    if (chatAttempts === 1) {
      return new Response(JSON.stringify({ error: { code: "rate_limit_exceeded" } }), {
        status: 429,
        headers: { "Retry-After": "1" },
      });
    }
    return new Response(ssePayload("hi"));
  });
  try {
    const model = await discoverChatModel(harness.provider);
    const reported: unknown[] = [];
    const outcome = chatOutcome(harness.provider, model, reported);
    await flushAsyncWork();
    assert.equal(chatAttempts, 1);

    // Nothing is retried before the gateway's Retry-After has elapsed.
    t.mock.timers.tick(999);
    await flushAsyncWork();
    assert.equal(chatAttempts, 1);

    t.mock.timers.tick(1);
    await flushAsyncWork();
    assert.equal(await outcome, undefined);
    assert.equal(chatAttempts, 2);
    assert.equal(reported.length, 1);
  } finally {
    harness.provider.dispose();
    globalThis.fetch = originalFetch;
  }
});

test("stops at maxRetries for a persistent gateway error and reports the mapped failure", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const originalFetch = globalThis.fetch;
  let chatAttempts = 0;
  const harness = createHarness(async (input) => {
    if (String(input).endsWith("/models")) {
      return modelListResponse({ data: [{ id: "mimo-v2.6-flash" }] });
    }
    chatAttempts += 1;
    return new Response("upstream unavailable", { status: 503 });
  });
  try {
    const model = await discoverChatModel(harness.provider);
    const outcome = chatOutcome(harness.provider, model, []);
    for (let step = 0; step < 8; step += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop
      await flushAsyncWork();
      t.mock.timers.tick(1_000);
    }
    const error = await outcome;
    assert.ok(error instanceof ProviderError);
    assert.equal(error.code, "gateway_error");
    // One request plus the two retries `nanBuilders.maxRetries` allows by default.
    assert.equal(chatAttempts, 3);
  } finally {
    harness.provider.dispose();
    globalThis.fetch = originalFetch;
  }
});

test("never retries a 429 that reports an exhausted credit pool", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const originalFetch = globalThis.fetch;
  let chatAttempts = 0;
  const harness = createHarness(async (input) => {
    if (String(input).endsWith("/models")) {
      return modelListResponse({ data: [{ id: "mimo-v2.6-flash" }] });
    }
    chatAttempts += 1;
    return new Response(JSON.stringify({ error: { code: "insufficient_quota" } }), {
      status: 429,
      headers: { "Retry-After": "1" },
    });
  });
  try {
    const model = await discoverChatModel(harness.provider);
    const error = await chatOutcome(harness.provider, model, []);
    t.mock.timers.tick(30_000);
    await flushAsyncWork();
    assert.ok(error instanceof ProviderError);
    assert.equal(error.code, "insufficient_quota");
    assert.equal(chatAttempts, 1);
  } finally {
    harness.provider.dispose();
    globalThis.fetch = originalFetch;
  }
});

test("cancelling during a retry backoff sends no further request and frees the slot", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const originalFetch = globalThis.fetch;
  const slots = new SlotQueueRegistry(1);
  let chatAttempts = 0;
  const harness = createHarness(
    async (input) => {
      if (String(input).endsWith("/models")) {
        return modelListResponse({ data: [{ id: "mimo-v2.6-flash" }] });
      }
      chatAttempts += 1;
      return new Response("upstream unavailable", { status: 503 });
    },
    undefined,
    slots,
  );
  const keySlots = () => slots.forCredential(credentialId("unit-test-key"));
  try {
    const model = await discoverChatModel(harness.provider);
    const token = new TestCancellationToken();
    const reported: unknown[] = [];
    const outcome = chatOutcome(harness.provider, model, reported, token);
    await flushAsyncWork();
    assert.equal(chatAttempts, 1);
    // The failed request already released its slot, so the backoff holds none.
    assert.equal(keySlots().inUse, 0);

    token.cancel();
    assert.equal(await outcome, undefined);
    await flushAsyncWork();
    assert.equal(chatAttempts, 1);
    assert.equal(keySlots().inUse, 0);

    t.mock.timers.tick(60_000);
    await flushAsyncWork();
    assert.equal(chatAttempts, 1);
    assert.deepEqual(reported, []);
  } finally {
    harness.provider.dispose();
    globalThis.fetch = originalFetch;
  }
});

test("nanBuilders.maxRetries 0 restores one request per turn and no retry wait", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const originalFetch = globalThis.fetch;
  let chatAttempts = 0;
  const harness = createHarness(async (input) => {
    if (String(input).endsWith("/models")) {
      return modelListResponse({ data: [{ id: "mimo-v2.6-flash" }] });
    }
    chatAttempts += 1;
    return new Response(JSON.stringify({ error: { code: "rate_limit_exceeded" } }), {
      status: 429,
      headers: { "Retry-After": "1" },
    });
  });
  try {
    const model = await discoverChatModel(harness.provider);
    settings.set("maxRetries", 0);
    const error = await chatOutcome(harness.provider, model, []);
    t.mock.timers.tick(30_000);
    await flushAsyncWork();
    assert.ok(error instanceof ProviderError);
    assert.equal(error.code, "rate_limit_exceeded");
    assert.equal(chatAttempts, 1);
  } finally {
    harness.provider.dispose();
    globalThis.fetch = originalFetch;
  }
});

test("retries on the same key before the opt-in failover hops to another profile", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const originalFetch = globalThis.fetch;
  settings.clear();
  settings.set("apiBaseUrl", "https://unit.test/v1/");
  settings.set("includeUnknownModels", false);
  settings.set("modelCacheSeconds", 300);
  settings.set("profiles", ["personal", "work"]);
  settings.set("activeProfile", "personal");
  settings.set("failoverOnThrottle", true);
  const profileKeys: Record<string, string> = {
    "nanBuilders.profileKey.personal": "personal-key",
    "nanBuilders.profileKey.work": "work-key",
  };
  const usedKeys: string[] = [];
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/models")) {
      return modelListResponse({ data: [{ id: "mimo-v2.6-flash" }] });
    }
    const authorization = new Headers(init?.headers).get("Authorization") ?? "";
    usedKeys.push(authorization);
    if (authorization === "Bearer personal-key") {
      return new Response(JSON.stringify({ error: { code: "rate_limit_exceeded" } }), {
        status: 429,
        headers: { "Retry-After": "1" },
      });
    }
    return new Response(ssePayload("hi"));
  };
  const secrets: vscode.SecretStorage = {
    keys: async () => Object.keys(profileKeys),
    get: async (key) => profileKeys[key],
    store: async () => undefined,
    delete: async () => undefined,
    onDidChange: () => ({ dispose: () => undefined }),
  };
  const provider = new NanChatModelProvider(
    { secrets, globalState: new FakeMemento() },
    { record: async () => undefined },
    { authorize: async () => undefined },
    new SlotQueueRegistry(1),
  );
  try {
    const model = await discoverChatModel(provider);
    const reported: unknown[] = [];
    const outcome = chatOutcome(provider, model, reported);
    for (let step = 0; step < 10; step += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop
      await flushAsyncWork();
      t.mock.timers.tick(1_000);
    }
    assert.equal(await outcome, undefined);
    // #151 exhausts the retries on the routed key first; only then may #144 hop.
    assert.deepEqual(usedKeys, [
      "Bearer personal-key",
      "Bearer personal-key",
      "Bearer personal-key",
      "Bearer work-key",
    ]);
    assert.equal(reported.length, 1);
  } finally {
    provider.dispose();
    globalThis.fetch = originalFetch;
  }
});