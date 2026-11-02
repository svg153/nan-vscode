import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

export async function run(): Promise<void> {
  let chatRequest: Record<string, unknown> | undefined;
  let completionRequest: Record<string, unknown> | undefined;
  let completionRequests = 0;
  const routedRequests: string[] = [];
  let originalGlobalFetch: typeof fetch | undefined;
  let cancelResponse: http.ServerResponse | undefined;
  let onCancelRequest: (() => void) | undefined;
  let serverError: Error | undefined;
  const server = http.createServer((request, response) => {
    if (request.headers.authorization !== "Bearer integration-test-key") {
      response.writeHead(401).end();
      return;
    }
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "glm5.3-flash" }] }));
      return;
    }
    if (request.method === "GET" && request.url?.startsWith("/v1/usage")) {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "No usage report in integration fixture." } }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/completions") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => (body += chunk));
      request.on("end", () => {
        try {
          completionRequest = JSON.parse(body) as Record<string, unknown>;
        } catch {
          serverError = new Error("Completion request body was invalid JSON.");
          response.writeHead(400).end();
          return;
        }
        completionRequests += 1;
        const sendCompletion = () => {
          if (response.destroyed) {
            return;
          }
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(
            JSON.stringify({
              id: "cmpl-integration",
              object: "text_completion",
              created: 0,
              model: completionRequest?.model,
              choices: [{ text: "INLINE_OK", index: 0, finish_reason: "stop" }],
            }),
          );
        };
        if (String(completionRequest.prompt ?? "").includes("CANCEL_LATE")) {
          // Cancel exactly when the server receives the request (in-flight, deterministic)
          // and answer late for anyone still listening.
          testApi?.cancelInlineTest();
          setTimeout(sendCompletion, 3_000);
        } else {
          sendCompletion();
        }
      });
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }

    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (body += chunk));
    request.on("end", () => {
      try {
        chatRequest = JSON.parse(body) as Record<string, unknown>;
      } catch {
        serverError = new Error("Chat request body was invalid JSON.");
        response.writeHead(400).end();
        return;
      }
      const messages = chatRequest.messages as Array<{ content?: string }>;
      if (messages.some(({ content }) => content === "TRUNCATE_NOW")) {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.end([
          'data: {"choices":[{"delta":{},"finish_reason":"length"}]}' + "\n",
          'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":15,"total_tokens":17,"estimated":true,"billed":false,"nan_truncation":true}}' + "\n",
          "data: [DONE]\n\n",
        ].join(""));
        return;
      }
      if (messages.some(({ content }) => content === "CANCEL_NOW")) {
        cancelResponse = response;
        onCancelRequest?.();
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end([
        'data: {"choices":[{"delta":{"reasoning_content":"private reasoning"}}]}\n',
        'data: {"choices":[{"delta":{"content":"NAN_OK"}}]}\n',
        'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\n',
        "data: [DONE]\n\n",
      ].join("\n"));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  let testApi: {
    setTestApiKey(key: string): Promise<void>;
    clearTestApiKey(): Promise<void>;
    validateModelsTest(): Promise<number>;
    refreshUsageTest(): Promise<void>;
    setHttpConsentTest(approved: boolean): void;
    readHttpConsentPromptsTest(): string[];
    readTestUsageHistory(): unknown;
    clearTestUsageHistory(): Promise<boolean>;
    provideInlineTest(
      document: vscode.TextDocument,
      position: vscode.Position,
      options?: { cancelDuringStartup?: boolean },
    ): Promise<vscode.InlineCompletionItem[] | undefined>;
    cancelInlineTest(): void;
    getInlineRegistrationTest(): vscode.DocumentSelector | undefined;
  } | undefined;
  let previousBaseUrl: string | undefined;
  let previousCompletionModel: string | undefined;
  let config: vscode.WorkspaceConfiguration | undefined;
  let source: vscode.CancellationTokenSource | undefined;
  let timeout: NodeJS.Timeout | undefined;
  let tempDir: string | undefined;
  try {
    const extension = vscode.extensions.getExtension<{
      setTestApiKey(key: string): Promise<void>;
      clearTestApiKey(): Promise<void>;
      validateModelsTest(): Promise<number>;
      refreshUsageTest(): Promise<void>;
      setHttpConsentTest(approved: boolean): void;
      readHttpConsentPromptsTest(): string[];
      readTestUsageHistory(): unknown;
      clearTestUsageHistory(): Promise<boolean>;
      provideInlineTest(
        document: vscode.TextDocument,
        position: vscode.Position,
        options?: { cancelDuringStartup?: boolean },
      ): Promise<vscode.InlineCompletionItem[] | undefined>;
      cancelInlineTest(): void;
      getInlineRegistrationTest(): vscode.DocumentSelector | undefined;
    }>("svg153.nan-builders-vscode");
    assert.ok(extension, "NaN Builders extension is not loaded in the development host.");
    assert.deepEqual(extension.packageJSON.extensionKind, ["workspace", "ui"]);
    config = vscode.workspace.getConfiguration("nanBuilders");
    previousBaseUrl = config.get<string>("apiBaseUrl");
    previousCompletionModel = config.get<string>("completionModel");
    await config.update("completionModel", "", vscode.ConfigurationTarget.Global);
    testApi = await extension.activate();
    assert.ok(testApi, `Test hook missing (extension path ${extension.extensionPath}).`);
    const activeTestApi = testApi;
    assert.equal(
      testApi.getInlineRegistrationTest(),
      undefined,
      "Inline provider must not be registered when completionModel is empty.",
    );
    originalGlobalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const requestUrl = new URL(String(input));
      if (requestUrl.hostname === "api.example.test") {
        routedRequests.push(requestUrl.pathname);
        const localUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, `http://127.0.0.1:${address.port}`);
        return originalGlobalFetch!(localUrl, init);
      }
      return originalGlobalFetch!(input, init);
    };
    const remoteEndpoint = `http://api.example.test:${address.port}/v1`;
    await config.update("apiBaseUrl", remoteEndpoint, vscode.ConfigurationTarget.Global);
    await testApi.setTestApiKey("integration-test-key");
    assert.equal(await testApi.clearTestUsageHistory(), true);

    await assert.rejects(testApi.validateModelsTest(), (error: unknown) =>
      error instanceof Error && error.name === "AbortError",
    );
    const promptsAfterCancel = testApi.readHttpConsentPromptsTest();
    assert.ok(promptsAfterCancel.length >= 1);
    assert.ok(promptsAfterCancel.every((endpoint) => endpoint === remoteEndpoint));
    assert.equal(routedRequests.length, 0, "Canceling remote HTTP confirmation must prevent network requests.");
    testApi.setHttpConsentTest(true);

    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () =>
        responseWithStatusText(503, `Bearer secret_token_123\x01${"X".repeat(300)}`);
      await assert.rejects(testApi.validateModelsTest(), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /^Unable to discover NaN Builders models: HTTP 503 /);
        assert.doesNotMatch(error.message, /secret_token_123/);
        assert.equal(
          Array.from(error.message).some((character) => {
            const code = character.charCodeAt(0);
            return code < 0x20 || code === 0x7f;
          }),
          false,
        );
        assert.ok(error.message.length <= "Unable to discover NaN Builders models: HTTP 503 ".length + 200);
        return true;
      });

      const assertAuthStatus = async (status: number): Promise<void> => {
        globalThis.fetch = async () => new Response(null, { status, statusText: "Rejected" });
        await assert.rejects(
          activeTestApi.validateModelsTest(),
          /NaN Builders rejected the API key\. Update it with 'NaN Builders: Manage Provider'\./,
        );
      };
      await assertAuthStatus(401);
      await assertAuthStatus(403);
    } finally {
      globalThis.fetch = originalFetch;
    }
    const promptsAfterApproval = testApi.readHttpConsentPromptsTest();
    assert.ok(promptsAfterApproval.length > promptsAfterCancel.length);
    assert.ok(promptsAfterApproval.every((endpoint) => endpoint === remoteEndpoint));

    source = new vscode.CancellationTokenSource();
    timeout = setTimeout(() => source?.cancel(), 10_000);
    const models = await vscode.lm.selectChatModels({ vendor: "nan-builders" });
    const model = models.find(({ id }) => id === "glm5.3-flash");
    assert.ok(model, "Provider did not surface the mock NaN model.");

    const response = await model.sendRequest(
      [vscode.LanguageModelChatMessage.User("Reply with exactly NAN_OK.")],
      {},
      source.token,
    );
    let text = "";
    for await (const part of response.stream) {
      if (part instanceof vscode.LanguageModelTextPart) {
        text += part.value;
      }
    }

    assert.equal(text, "NAN_OK");
    assert.ifError(serverError);
    assert.equal(chatRequest?.model, "glm5.3-flash");
    assert.equal(chatRequest?.stream, true);
    assert.equal(chatRequest?.reasoning_effort, "low");
    assert.deepEqual(testApi.readTestUsageHistory(), [{
      date: new Date().toISOString().slice(0, 10),
      modelId: "glm5.3-flash",
      requests: 1,
      promptTokens: 2,
      completionTokens: 1,
    }]);

    assert.equal(await testApi.clearTestUsageHistory(), true);
    assert.deepEqual(testApi.readTestUsageHistory(), []);

    assert.ok(source);
    const requestToken = source.token;
    const truncatedResponse = await model.sendRequest(
      [vscode.LanguageModelChatMessage.User("TRUNCATE_NOW")],
      {},
      requestToken,
    );
    await assert.rejects(
      async () => {
        for await (const _part of truncatedResponse.stream) {
          // A reasoning-only truncation must not look like a successful empty reply.
        }
      },
      /NaN ended the turn before producing a reply because it reached its reasoning-only limit/,
    );

    const cancellation = new vscode.CancellationTokenSource();
    try {
      const cancelRequestReceived = new Promise<void>((resolve, reject) => {
        const requestTimeout = setTimeout(() => reject(new Error("Mock cancellation request was not received.")), 5_000);
        onCancelRequest = () => {
          clearTimeout(requestTimeout);
          resolve();
        };
      });
      const cancelModel = models.find(({ id }) => id === "glm5.3-flash");
      assert.ok(cancelModel);
      const cancelStream = await cancelModel.sendRequest(
        [vscode.LanguageModelChatMessage.User("CANCEL_NOW")],
        {},
        cancellation.token,
      );
      const consume = (async () => {
        for await (const _part of cancelStream.stream) {
          // The mock holds this stream open until the cancellation token aborts it.
        }
      })();
      await cancelRequestReceived;
      cancellation.cancel();
      await assert.doesNotReject(consume);
    } finally {
      cancellation.dispose();
      cancelResponse?.end();
    }

    // Inline ghost-text: opt-in via nanBuilders.completionModel, bounded payload.
    // Documentos con scheme "file" para cubrir el path registrado por el proveedor
    // (registerInlineCompletionItemProvider({ scheme: "file" }, ...)).
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nan-inline-"));
    await config.update("completionModel", "glm5.3-flash", vscode.ConfigurationTarget.Global);
    const inlinePath = path.join(tempDir, "inline.js");
    fs.writeFileSync(inlinePath, "const answer = ", "utf8");
    const inlineDoc = await vscode.workspace.openTextDocument(inlinePath);
    assert.equal(inlineDoc.uri.scheme, "file");
    assert.deepEqual(
      testApi.getInlineRegistrationTest(),
      [{ scheme: "file" }],
      "Inline provider must be registered with a file-scheme selector.",
    );
    const cursor = inlineDoc.positionAt(inlineDoc.getText().length);
    const items = await testApi.provideInlineTest(inlineDoc, cursor);
    assert.equal(completionRequests, 1, "Expected exactly one POST /completions request.");
    assert.equal(completionRequest?.model, "glm5.3-flash");
    assert.equal(completionRequest?.max_tokens, 64);
    assert.equal(completionRequest?.temperature, 0);
    assert.equal(completionRequest?.prompt, "const answer = ");
    const inlineItem = items?.[0];
    assert.ok(inlineItem, "Expected one inline completion item.");
    assert.equal(inlineItem.insertText, "INLINE_OK");
    const inlineRange = inlineItem.range;
    assert.ok(inlineRange, "Expected a range at the cursor.");
    assert.equal(inlineRange.start.line, cursor.line);
    assert.equal(inlineRange.start.character, cursor.character);
    assert.equal(inlineRange.end.line, cursor.line);
    assert.equal(inlineRange.end.character, cursor.character);

    // Cancelación a nivel de proveedor: el token se cancela en cuanto el mock
    // recibe la solicitud (en vuelo) y el proveedor devuelve undefined sin texto.
    const cancelPath = path.join(tempDir, "cancel.js");
    fs.writeFileSync(cancelPath, "// CANCEL_LATE", "utf8");
    const cancelDoc = await vscode.workspace.openTextDocument(cancelPath);
    const cancelItems = await testApi.provideInlineTest(
      cancelDoc,
      cancelDoc.positionAt(cancelDoc.getText().length),
    );
    assert.equal(cancelItems, undefined, "Cancelled request must not yield items.");
    assert.equal(completionRequests, 2, "Cancellation must not skip the request itself.");

    // Cancelación durante el arranque: el token se cancela exactamente en el
    // límite de secrets.get, tras la comprobación de entrada y antes de la
    // solicitud, sin depender de temporizadores.
    const earlyCancelItems = await testApi.provideInlineTest(inlineDoc, cursor, { cancelDuringStartup: true });
    assert.equal(earlyCancelItems, undefined, "Token cancelled during startup must not yield items.");
    assert.equal(completionRequests, 2, "Token cancelled during startup must not send requests.");

    // Disabled when the setting is empty: no request, no stale text.
    await config.update("completionModel", "", vscode.ConfigurationTarget.Global);
    assert.equal(testApi.getInlineRegistrationTest(), undefined, "Clearing completionModel must dispose the registration.");
    assert.equal(await testApi.provideInlineTest(inlineDoc, cursor), undefined);
    assert.equal(completionRequests, 2, "Disabled feature must not send requests.");
    await testApi.refreshUsageTest();
    assert.ok(routedRequests.includes("/v1/models"), "Model discovery must use the authorized remote endpoint.");
    assert.ok(routedRequests.includes("/v1/chat/completions"), "Chat must use the authorized remote endpoint.");
    assert.ok(routedRequests.includes("/v1/completions"), "Inline completions must use the authorized remote endpoint.");
    assert.ok(routedRequests.includes("/v1/usage"), "Account usage must use the authorized remote endpoint.");
    assert.equal(
      testApi.readHttpConsentPromptsTest().length,
      promptsAfterApproval.length,
      "Approval for an endpoint must be shared across model, chat, usage, and inline requests.",
    );
    assert.ifError(serverError);

    console.log("NaN Builders VS Code integration test passed (mock API; no real key used).");
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    source?.dispose();
    await testApi?.clearTestApiKey();
    if (config) {
      await config.update("apiBaseUrl", previousBaseUrl, vscode.ConfigurationTarget.Global);
      await config.update("completionModel", previousCompletionModel, vscode.ConfigurationTarget.Global);
    }
    if (originalGlobalFetch) {
      globalThis.fetch = originalGlobalFetch;
    }
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function responseWithStatusText(status: number, statusText: string): Response {
  const mockedResponse = new Response(null, { status });
  Object.defineProperty(mockedResponse, "statusText", { value: statusText });
  return mockedResponse;
}
