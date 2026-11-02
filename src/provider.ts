import * as vscode from "vscode";
import { DEFAULT_API_BASE_URL, SECRET_API_KEY } from "./constants";
import { diagnostic } from "./diagnostics";
import {
  filterDiscoveredModels,
  getKnownModel,
  reasoningDescription,
  toDisplayMetadata,
  type DiscoveredModel,
} from "./modelCatalog";
import { convertMessages, convertTools, estimateTokens, httpError, isImagePart, reasoningEffort } from "./openai/request";
import { OpenAIStreamDecoder, StreamLimitError, type StreamEvent } from "./openai/stream";
import type { OpenAIUsage } from "./openai/types";
import { sanitizeUpstreamText } from "./text";
import type { HttpEndpointAuthorizer } from "./httpEndpointGuard";
import type { UsageTracker } from "./usageTracker";
import {
  MAX_ERROR_RESPONSE_BYTES,
  MAX_JSON_RESPONSE_BYTES,
  ResponseTooLargeError,
  readBoundedJson,
  readBoundedResponseText,
} from "./responseBody";

interface ModelListResponse {
  data?: DiscoveredModel[];
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
    private readonly context: Pick<vscode.ExtensionContext, "secrets">,
    private readonly usage: Pick<UsageTracker, "record">,
    private readonly endpointAuthorizer: HttpEndpointAuthorizer,
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

    let models: DiscoveredModel[];
    try {
          models = await this.fetchModelIds(apiKey, token);
    } catch (error) {
      if (isAbortError(error)) {
        return [];
      }
      throw error;
    }
    const includeUnknown = vscode.workspace
      .getConfiguration("nanBuilders")
      .get<boolean>("includeUnknownModels", false);

    // NaN documents /v1/models as the definitive, API-key-filtered list.
    // Only expose model IDs returned for this key. Known non-chat endpoints are
    // filtered out; unknown IDs are opt-in because a future non-chat endpoint
    // must not accidentally be advertised to VS Code as a chat model.
        const chatModels = filterDiscoveredModels(models, includeUnknown);
        const vsCodeModels = chatModels.map((m) => this.toVsCodeModel(m));
    const cacheSeconds = vscode.workspace
      .getConfiguration("nanBuilders")
      .get<number>("modelCacheSeconds", 300);

    this.cache = {
          models: vsCodeModels,
      expiresAt: Date.now() + Math.max(0, cacheSeconds) * 1000,
    };
        diagnostic("models.provide.complete", { discoveredIdCount: models.length, chatModelCount: vsCodeModels.length });
        return vsCodeModels;
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

    const toolMapping = convertTools(options.tools ?? [], options.toolMode === vscode.LanguageModelChatToolMode.Required);
    const openaiMessages = convertMessages(
      messages.map((message) => ({
        role: message.role === vscode.LanguageModelChatMessageRole.User ? "user" : "assistant",
        content: message.content ?? [],
      })),
      toolMapping.originalToSanitized,
    );
    const requestBody: Record<string, unknown> = {
      model: model.id,
      messages: openaiMessages,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: model.maxOutputTokens || 4096,
      // NaN can spend several minutes in silent reasoning unless this is bounded.
            reasoning_effort: reasoningEffort(
              options.modelOptions,
              vscode.workspace.getConfiguration("nanBuilders").get<string>("defaultReasoningEffort", "low"),
            ),
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
      const reportStreamEvents = (events: StreamEvent[]): void => {
        for (const event of events) {
          if (token.isCancellationRequested) {
            return;
          }
          if (event.type === "text") {
            progress.report(new vscode.LanguageModelTextPart(event.text));
          } else if (event.type === "tool") {
            const originalName = toolMapping.sanitizedToOriginal.get(event.tool.name) ?? event.tool.name;
            progress.report(new vscode.LanguageModelToolCallPart(event.tool.id, originalName, event.tool.input));
          } else {
            lastUsage = event.usage;
          }
        }
      };

      while (!token.isCancellationRequested) {
              // oxlint-disable-next-line eslint/no-await-in-loop
              const { done, value } = await reader.read();
        if (token.isCancellationRequested) {
          break;
        }
        if (done) {
          break;
        }
        chunkCount += 1;
        reportStreamEvents(streamDecoder.push(textDecoder.decode(value, { stream: true })));
      }

      if (!token.isCancellationRequested) {
        reportStreamEvents(streamDecoder.push(textDecoder.decode()));
        reportStreamEvents(streamDecoder.finish());
      }
      if (!token.isCancellationRequested) {
        await this.usage.record(model.id, lastUsage);
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
      if (error instanceof StreamLimitError && reader) {
        try {
          await reader.cancel(error);
        } catch (cancelError) {
          diagnostic("chat.stream.cancel.error", {
            modelId: model.id,
            errorName: cancelError instanceof Error ? cancelError.name : typeof cancelError,
          });
        }
      }
      diagnostic("chat.error", {
        modelId: model.id,
        elapsedMs: Date.now() - startedAt,
        errorName: error instanceof Error ? error.name : typeof error,
        cancelled: token.isCancellationRequested,
      });
      if (!token.isCancellationRequested && !isAbortError(error)) {
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

  private async fetchModelIds(apiKey: string, token: vscode.CancellationToken): Promise<DiscoveredModel[]> {
      const startedAt = Date.now();
      diagnostic("models.fetch.begin", { cancelled: token.isCancellationRequested });
      const cancellation = cancellationSignal(token);
      let response: Response;
      let body: ModelListResponse;
      try {
        const baseUrl = this.apiBaseUrl();
        await this.endpointAuthorizer.authorize(baseUrl, cancellation.signal);
        response = await fetch(`${baseUrl}/models`, {
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
          await response.body?.cancel();
          if (response.status === 401 || response.status === 403) {
            throw new Error("NaN Builders rejected the API key. Update it with 'NaN Builders: Manage Provider'.");
          }
          throw new Error(
            `Unable to discover NaN Builders models: HTTP ${response.status} ${sanitizeUpstreamText(response.statusText, 200)}`,
          );
        }
        body = (await readBoundedJson(response, MAX_JSON_RESPONSE_BYTES)) as ModelListResponse;
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

      return body.data ?? [];
    }

  private async sendChatRequest(
    apiKey: string,
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Response> {
    const baseUrl = this.apiBaseUrl();
    await this.endpointAuthorizer.authorize(baseUrl, signal);
    const send = async (requestBody: Record<string, unknown>): Promise<Response> =>
      fetch(`${baseUrl}/chat/completions`, {
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
      const text = await readChatErrorText(response);
      if (
        response.status === 400 &&
        "stream_options" in body &&
        /stream[_ -]?options|include[_ -]?usage/i.test(text)
      ) {
        const fallback = { ...body };
        delete fallback.stream_options;
        response = await send(fallback);
      } else {
        throw httpError(response.status, response.statusText, text);
      }
    }

    if (!response.ok) {
      const text = await readChatErrorText(response);
      throw httpError(response.status, response.statusText, text);
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

  private toVsCodeModel(discovered: DiscoveredModel): vscode.LanguageModelChatInformation {
      const metadata = toDisplayMetadata(discovered.id, discovered);
      const known = getKnownModel(discovered.id);
    return {
      id: metadata.id,
      name: metadata.premium ? `${metadata.name} (premium)` : metadata.name,
      family: metadata.id,
      version: "1",
      maxInputTokens: Math.max(1, metadata.contextWindow - metadata.maxOutputTokens),
      maxOutputTokens: metadata.maxOutputTokens,
      detail: known ? "NaN Builders" : "NaN Builders - metadata unknown",
      tooltip: [
        known
          ? `NaN Builders hosted ${metadata.name}`
          : "Discovered from NaN Builders. Tool calling is disabled until metadata is known.",
        reasoningDescription(metadata),
      ].join("\n"),
      capabilities: {
        imageInput: metadata.imageInput,
        toolCalling: metadata.toolCalling,
      },
    };
  }
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

async function readChatErrorText(response: Response): Promise<string> {
  try {
    return await readBoundedResponseText(response, MAX_ERROR_RESPONSE_BYTES);
  } catch (error) {
    if (error instanceof ResponseTooLargeError) {
      return "";
    }
    throw error;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
