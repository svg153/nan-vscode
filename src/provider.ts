import * as vscode from "vscode";
import { DEFAULT_API_BASE_URL, SECRET_API_KEY } from "./constants";
import { diagnostic } from "./diagnostics";
import { filterDiscoveredModelIds, getKnownModel, toDisplayMetadata } from "./modelCatalog";
import { OpenAIStreamDecoder } from "./openai/stream";
import { buildToolNameMappings, sanitizeSchema, sanitizeToolName } from "./openai/tooling";
import type { OpenAIContentPart, OpenAIMessage, OpenAIToolDefinition, OpenAIUsage } from "./openai/types";
import { UsageTracker } from "./usageTracker";

interface ModelListResponse {
  data?: Array<{ id?: string }>;
}

interface ToolMapping {
  readonly definitions: OpenAIToolDefinition[];
  readonly sanitizedToOriginal: ReadonlyMap<string, string>;
  readonly originalToSanitized: ReadonlyMap<string, string>;
  readonly toolChoice?: "auto" | "required" | { type: "function"; function: { name: string } };
}

interface CachedModels {
  readonly expiresAt: number;
  readonly models: vscode.LanguageModelChatInformation[];
}

export class NanChatModelProvider implements vscode.LanguageModelChatProvider, vscode.Disposable {
  private readonly changedEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.changedEmitter.event;

  private cache: CachedModels | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly usage: UsageTracker,
  ) {}

  dispose(): void {
    this.changedEmitter.dispose();
  }

  async provideLanguageModelChatInformation(
    options: { silent: boolean },
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    diagnostic("models.provide.begin", { silent: options.silent, cancelled: token.isCancellationRequested });
    if (token.isCancellationRequested) {
      diagnostic("models.provide.cancelled");
      return [];
    }

    const cached = this.cache;
    if (cached && cached.expiresAt > Date.now()) {
      diagnostic("models.provide.cacheHit", { modelCount: cached.models.length });
      return cached.models;
    }

    const apiKey = await this.getApiKey(options.silent);
    if (!apiKey) {
      diagnostic("models.provide.noKey", { silent: options.silent });
      return [];
    }

    const ids = await this.fetchModelIds(apiKey, token);
    const includeUnknown = vscode.workspace
      .getConfiguration("nanBuilders")
      .get<boolean>("includeUnknownModels", false);

    // NaN documents /v1/models as the definitive, API-key-filtered list.
    // Only expose model IDs returned for this key. Known non-chat endpoints are
    // filtered out; unknown IDs are opt-in because a future non-chat endpoint
    // must not accidentally be advertised to VS Code as a chat model.
    const modelIds = filterDiscoveredModelIds(ids, includeUnknown);
    const models = modelIds.map((id) => this.toVsCodeModel(id));
    const cacheSeconds = vscode.workspace
      .getConfiguration("nanBuilders")
      .get<number>("modelCacheSeconds", 300);

    this.cache = {
      models,
      expiresAt: Date.now() + Math.max(0, cacheSeconds) * 1000,
    };
    diagnostic("models.provide.complete", { discoveredIdCount: ids.length, chatModelCount: models.length });
    return models;
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const startedAt = Date.now();
    diagnostic("chat.begin", { modelId: model.id, messageCount: messages.length, toolCount: options.tools?.length ?? 0 });
    const apiKey = await this.getApiKey(false);
    if (!apiKey) {
      diagnostic("chat.noKey", { modelId: model.id });
      throw new Error("NaN Builders API key is not configured. Run 'NaN Builders: Manage Provider'.");
    }

    const toolMapping = convertTools(options);
    const openaiMessages = convertMessages(messages, toolMapping.originalToSanitized);
    const requestBody: Record<string, unknown> = {
      model: model.id,
      messages: openaiMessages,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: model.maxOutputTokens || 4096,
      // NaN can spend several minutes in silent reasoning unless this is bounded.
      reasoning_effort: reasoningEffort(options.modelOptions),
    };

    if (toolMapping.definitions.length > 0) {
      requestBody.tools = toolMapping.definitions;
      requestBody.tool_choice = toolMapping.toolChoice ?? "auto";
    }

    const cancellation = cancellationSignal(token);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let chunkCount = 0;
    try {
      const response = await this.sendChatRequest(apiKey, requestBody, cancellation.signal);
      diagnostic("chat.http.response", { modelId: model.id, status: response.status, elapsedMs: Date.now() - startedAt });
      if (!response.body) {
        throw new Error("NaN Builders returned an empty streaming response.");
      }

      reader = response.body.getReader();
      const textDecoder = new TextDecoder();
      const streamDecoder = new OpenAIStreamDecoder();
      let lastUsage: OpenAIUsage | undefined;

      while (!token.isCancellationRequested) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        chunkCount += 1;
        const events = streamDecoder.push(textDecoder.decode(value, { stream: true }));
        for (const event of events) {
          if (event.type === "text") {
            progress.report(new vscode.LanguageModelTextPart(event.text));
          } else if (event.type === "tool") {
            const originalName = toolMapping.sanitizedToOriginal.get(event.tool.name) ?? event.tool.name;
            progress.report(new vscode.LanguageModelToolCallPart(event.tool.id, originalName, event.tool.input));
          } else {
            lastUsage = event.usage;
          }
        }
      }

      for (const event of streamDecoder.finish()) {
        if (event.type === "text") {
          progress.report(new vscode.LanguageModelTextPart(event.text));
        } else if (event.type === "tool") {
          const originalName = toolMapping.sanitizedToOriginal.get(event.tool.name) ?? event.tool.name;
          progress.report(new vscode.LanguageModelToolCallPart(event.tool.id, originalName, event.tool.input));
        } else {
          lastUsage = event.usage;
        }
      }
      if (!token.isCancellationRequested) {
        this.usage.record(model.id, lastUsage);
        diagnostic("chat.complete", {
          modelId: model.id,
          elapsedMs: Date.now() - startedAt,
          chunkCount,
          hasUsage: Boolean(lastUsage),
          truncated: Boolean(lastUsage?.nan_truncation),
        });
        if (lastUsage?.nan_truncation) {
          throw new Error(
            "NaN ended the turn before producing a reply because it reached its reasoning-only limit. Try a shorter prompt or a model with adjustable reasoning.",
          );
        }
      }
    } catch (error) {
      diagnostic("chat.error", {
        modelId: model.id,
        elapsedMs: Date.now() - startedAt,
        errorName: error instanceof Error ? error.name : typeof error,
        cancelled: token.isCancellationRequested,
      });
      if (!token.isCancellationRequested) {
        throw error;
      }
    } finally {
      reader?.releaseLock();
      cancellation.dispose();
      diagnostic("chat.finally", { modelId: model.id, cancelled: token.isCancellationRequested });
    }
  }

  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    if (typeof text === "string") {
      return estimateTokens(text);
    }

    let characters = 0;
    for (const part of text.content ?? []) {
      if (part instanceof vscode.LanguageModelTextPart) {
        characters += part.value.length;
      } else if (isImagePart(part)) {
        characters += Math.ceil(part.data.byteLength / 3);
      } else {
        characters += 64;
      }
    }
    return Math.max(1, Math.ceil(characters / 4));
  }

  async setApiKey(apiKey: string): Promise<void> {
    await this.context.secrets.store(SECRET_API_KEY, apiKey.trim());
    this.refresh();
  }

  async clearApiKey(): Promise<void> {
    await this.context.secrets.delete(SECRET_API_KEY);
    this.refresh();
  }

  async validateConfiguredKey(): Promise<number> {
    const apiKey = await this.context.secrets.get(SECRET_API_KEY);
    if (!apiKey) {
      throw new Error("No NaN Builders API key is configured.");
    }
    const source = new vscode.CancellationTokenSource();
    try {
      const ids = await this.fetchModelIds(apiKey, source.token);
      return ids.length;
    } finally {
      source.dispose();
    }
  }

  refresh(): void {
    this.cache = undefined;
    this.changedEmitter.fire();
  }

  private async getApiKey(silent: boolean): Promise<string | undefined> {
    let apiKey = await this.context.secrets.get(SECRET_API_KEY);
    if (apiKey || silent) {
      return apiKey;
    }

    const entered = await vscode.window.showInputBox({
      title: "NaN Builders API Key",
      prompt: "Paste your NaN Builders API key. It will be stored in VS Code SecretStorage.",
      password: true,
      ignoreFocusOut: true,
      placeHolder: "sk-...",
    });
    if (!entered?.trim()) {
      return undefined;
    }

    apiKey = entered.trim();
    await this.setApiKey(apiKey);
    return apiKey;
  }

  private async fetchModelIds(apiKey: string, token: vscode.CancellationToken): Promise<string[]> {
    const startedAt = Date.now();
    diagnostic("models.fetch.begin", { cancelled: token.isCancellationRequested });
    const cancellation = cancellationSignal(token);
    let response: Response;
    let body: ModelListResponse;
    try {
      response = await fetch(`${this.apiBaseUrl()}/models`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
          "User-Agent": this.userAgent(),
        },
        signal: cancellation.signal,
      });
      diagnostic("models.fetch.response", { status: response.status, elapsedMs: Date.now() - startedAt });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new Error("NaN Builders rejected the API key. Update it with 'NaN Builders: Manage Provider'.");
        }
        throw new Error(`Unable to discover NaN Builders models: HTTP ${response.status} ${response.statusText}`);
      }
      body = (await response.json()) as ModelListResponse;
      diagnostic("models.fetch.json", { rawModelCount: body.data?.length ?? 0, elapsedMs: Date.now() - startedAt });
    } catch (error) {
      diagnostic("models.fetch.error", {
        elapsedMs: Date.now() - startedAt,
        errorName: error instanceof Error ? error.name : typeof error,
        cancelled: token.isCancellationRequested,
      });
      throw error;
    } finally {
      cancellation.dispose();
    }

    return (body.data ?? [])
      .map((model) => model.id?.trim())
      .filter((id): id is string => Boolean(id));
  }

  private async sendChatRequest(
    apiKey: string,
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Response> {
    const send = async (requestBody: Record<string, unknown>): Promise<Response> =>
      fetch(`${this.apiBaseUrl()}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "User-Agent": this.userAgent(),
        },
        body: JSON.stringify(requestBody),
        signal,
      });

    let response = await send(body);
    if (!response.ok) {
      const text = await response.text();
      if (
        response.status === 400 &&
        "stream_options" in body &&
        /stream[_ -]?options|include[_ -]?usage/i.test(text)
      ) {
        const fallback = { ...body };
        delete fallback.stream_options;
        response = await send(fallback);
      } else {
        throw httpError(response, text);
      }
    }

    if (!response.ok) {
      const text = await response.text();
      throw httpError(response, text);
    }
    return response;
  }

  private apiBaseUrl(): string {
    return vscode.workspace
      .getConfiguration("nanBuilders")
      .get<string>("apiBaseUrl", DEFAULT_API_BASE_URL)
      .replace(/\/+$/, "");
  }

  private userAgent(): string {
    const extension = vscode.extensions.getExtension("svg153.nan-builders-vscode");
    const version = extension?.packageJSON?.version ?? "dev";
    return `nan-vscode/${version} VSCode/${vscode.version}`;
  }

  private toVsCodeModel(id: string): vscode.LanguageModelChatInformation {
    const metadata = toDisplayMetadata(id);
    const known = getKnownModel(id);
    return {
      id: metadata.id,
      name: metadata.premium ? `${metadata.name} (premium)` : metadata.name,
      family: metadata.id,
      version: "1",
      maxInputTokens: Math.max(1, metadata.contextWindow - metadata.maxOutputTokens),
      maxOutputTokens: metadata.maxOutputTokens,
      detail: known ? "NaN Builders" : "NaN Builders - metadata unknown",
      tooltip: known
        ? `NaN Builders hosted ${metadata.name}`
        : "Discovered from NaN Builders. Tool calling is disabled until metadata is known.",
      capabilities: {
        imageInput: metadata.imageInput,
        toolCalling: metadata.toolCalling,
      },
    };
  }
}

function httpError(response: Response, body: string): Error {
  const cleanBody = body.trim().slice(0, 500);
  const suffix = cleanBody ? `: ${cleanBody}` : "";
  return new Error(`NaN Builders API error ${response.status} ${response.statusText}${suffix}`);
}

function cancellationSignal(token: vscode.CancellationToken): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  if (token.isCancellationRequested) {
    controller.abort();
    return { signal: controller.signal, dispose: () => {} };
  }
  const listener = token.onCancellationRequested(() => controller.abort());
  return { signal: controller.signal, dispose: () => listener.dispose() };
}

function reasoningEffort(options: { readonly [name: string]: unknown } | undefined): string {
  const requested = options?.reasoning_effort;
  return typeof requested === "string" && /^(none|minimal|low|medium|high|max)$/.test(requested)
    ? requested
    : "low";
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function convertMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  originalToSanitized: ReadonlyMap<string, string>,
): OpenAIMessage[] {
  const converted: OpenAIMessage[] = [];

  for (const message of messages) {
    const textParts: OpenAIContentPart[] = [];
    const toolCalls: NonNullable<OpenAIMessage["tool_calls"]> = [];
    const toolResults: Array<{ callId: string; content: string }> = [];

    for (const part of message.content ?? []) {
      if (part instanceof vscode.LanguageModelTextPart) {
        textParts.push({ type: "text", text: part.value });
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        toolCalls.push({
          id: part.callId,
          type: "function",
          function: {
            name: originalToSanitized.get(part.name) ?? sanitizeToolName(part.name),
            arguments: safeStringify(part.input),
          },
        });
      } else if (isToolResultPart(part)) {
        toolResults.push({
          callId: part.callId,
          content: flattenToolResult(part.content),
        });
      } else if (isImagePart(part)) {
        textParts.push({
          type: "image_url",
          image_url: {
            url: `data:${part.mimeType};base64,${Buffer.from(part.data).toString("base64")}`,
          },
        });
      }
    }

    if (toolCalls.length > 0) {
      converted.push({
        role: "assistant",
        content: textParts.length ? contentValue(textParts) : null,
        tool_calls: toolCalls,
      });
    }

    for (const result of toolResults) {
      converted.push({
        role: "tool",
        tool_call_id: result.callId,
        content: result.content,
      });
    }

    if (toolCalls.length === 0 && textParts.length > 0) {
      converted.push({
        role: message.role === vscode.LanguageModelChatMessageRole.User ? "user" : "assistant",
        content: contentValue(textParts),
      });
    }
  }

  return converted;
}

function contentValue(parts: OpenAIContentPart[]): string | OpenAIContentPart[] {
  if (parts.every((part) => part.type === "text")) {
    return parts.map((part) => (part.type === "text" ? part.text : "")).join("");
  }
  return parts;
}

function convertTools(options: vscode.ProvideLanguageModelChatResponseOptions): ToolMapping {
  const tools = options.tools ?? [];
  const { originalToSanitized, sanitizedToOriginal } = buildToolNameMappings(tools.map((tool) => tool.name));
  const definitions: OpenAIToolDefinition[] = [];

  for (const tool of tools) {
    const sanitized = originalToSanitized.get(tool.name) ?? sanitizeToolName(tool.name);
    definitions.push({
      type: "function",
      function: {
        name: sanitized,
        description: tool.description,
        parameters: sanitizeSchema(tool.inputSchema),
      },
    });
  }

  let toolChoice: ToolMapping["toolChoice"];
  if (definitions.length > 0) {
    toolChoice = "auto";
  }
  if (options.toolMode === vscode.LanguageModelChatToolMode.Required) {
    toolChoice = "required";
  }

  return { definitions, sanitizedToOriginal, originalToSanitized, toolChoice };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

function isToolResultPart(value: unknown): value is { callId: string; content: readonly unknown[] } {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as { callId?: unknown; content?: unknown };
  return typeof candidate.callId === "string" && Array.isArray(candidate.content);
}

function isImagePart(value: unknown): value is { data: Uint8Array; mimeType: string } {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as { data?: unknown; mimeType?: unknown };
  return candidate.data instanceof Uint8Array && typeof candidate.mimeType === "string" && candidate.mimeType.startsWith("image/");
}

function flattenToolResult(content: readonly unknown[]): string {
  const pieces: string[] = [];
  for (const part of content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      pieces.push(part.value);
    } else if (typeof part === "string") {
      pieces.push(part);
    } else {
      pieces.push(safeStringify(part));
    }
  }
  return pieces.join("");
}
