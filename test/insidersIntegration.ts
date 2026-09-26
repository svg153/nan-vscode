import * as assert from "node:assert/strict";
import * as http from "node:http";
import * as vscode from "vscode";

export async function run(): Promise<void> {
  let chatRequest: Record<string, unknown> | undefined;
  let completionRequest: Record<string, unknown> | undefined;
  let completionRequests = 0;
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
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            id: "cmpl-integration",
            object: "text_completion",
            created: 0,
            model: completionRequest.model,
            choices: [{ text: "INLINE_OK", index: 0, finish_reason: "stop" }],
          }),
        );
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
    readTestUsageHistory(): unknown;
    clearTestUsageHistory(): Promise<boolean>;
    provideInlineTest(
      document: vscode.TextDocument,
      position: vscode.Position,
    ): Promise<vscode.InlineCompletionItem[] | undefined>;
  } | undefined;
  let previousBaseUrl: string | undefined;
  let previousCompletionModel: string | undefined;
  let config: vscode.WorkspaceConfiguration | undefined;
  let source: vscode.CancellationTokenSource | undefined;
  let timeout: NodeJS.Timeout | undefined;
  try {
    const extension = vscode.extensions.getExtension<{
      setTestApiKey(key: string): Promise<void>;
      clearTestApiKey(): Promise<void>;
      readTestUsageHistory(): unknown;
      clearTestUsageHistory(): Promise<boolean>;
      provideInlineTest(
        document: vscode.TextDocument,
        position: vscode.Position,
      ): Promise<vscode.InlineCompletionItem[] | undefined>;
    }>("svg153.nan-builders-vscode");
    assert.ok(extension, "NaN Builders extension is not loaded in the development host.");
    assert.deepEqual(extension.packageJSON.extensionKind, ["workspace", "ui"]);
    testApi = await extension.activate();
    assert.ok(testApi, `Test hook missing (extension path ${extension.extensionPath}).`);

    config = vscode.workspace.getConfiguration("nanBuilders");
    previousBaseUrl = config.get<string>("apiBaseUrl");
    previousCompletionModel = config.get<string>("completionModel");
    await config.update("apiBaseUrl", `http://127.0.0.1:${address.port}/v1`, vscode.ConfigurationTarget.Global);
    await testApi.setTestApiKey("integration-test-key");
    assert.equal(await testApi.clearTestUsageHistory(), true);

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
    await config.update("completionModel", "glm5.3-flash", vscode.ConfigurationTarget.Global);
    const inlineDoc = await vscode.workspace.openTextDocument({
      content: "const answer = ",
      language: "javascript",
    });
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
    // Disabled when the setting is empty: no request, no stale text.
    await config.update("completionModel", "", vscode.ConfigurationTarget.Global);
    assert.equal(await testApi.provideInlineTest(inlineDoc, cursor), undefined);
    assert.equal(completionRequests, 1, "Disabled feature must not send requests.");
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
      await config.update("completionModel", previousCompletionModel ?? "", vscode.ConfigurationTarget.Global);
    }
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}
