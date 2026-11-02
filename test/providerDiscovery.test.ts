import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import type * as vscode from "vscode";

type ModuleLoader = {
  _load: (request: string, parent: NodeJS.Module | null, isMain: boolean) => unknown;
};

class FakeEventEmitter {
  readonly event = () => ({ dispose: () => undefined });

  fire(): void {}

  dispose(): void {}
}

const moduleRequire = createRequire(__filename);
const moduleLoader = moduleRequire("node:module") as ModuleLoader;
const originalLoad = moduleLoader._load;
const settings = new Map<string, unknown>();
const vscodeStub = {
  EventEmitter: FakeEventEmitter,
  extensions: { getExtension: () => undefined },
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
    { record: async () => undefined },
    { authorize: async () => undefined },
  );
  return { provider, calls };
}

function modelListResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), init);
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
