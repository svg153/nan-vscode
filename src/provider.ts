import * as vscode from "vscode";
import { DEFAULT_API_BASE_URL, SECRET_API_KEY } from "./constants";
import { diagnostic } from "./diagnostics";
import {
  billingDescription,
  filterDiscoveredModels,
  getKnownModel,
  knownChatModelIds,
  reasoningDescription,
  resolveReasoningEffort,
  toDisplayMetadata,
  type DiscoveredModel,
  type ModelMetadata,
} from "./modelCatalog";
import { historyConversationKey, trimHistoryToBudget } from "./openai/historyTrim";
import { convertMessages, convertTools, RequestTimeoutError } from "./openai/request";
import { countContentTokens, estimateTokens } from "./openai/tokens";
import { credentialId, type SlotLease, type SlotQueueRegistry } from "./openai/slotQueue";
import { OpenAIStreamDecoder, StreamLimitError, type StreamEvent } from "./openai/stream";
import {
  ChatTimeoutController,
  DEFAULT_CONNECT_TIMEOUT_SECONDS,
  DEFAULT_STREAM_IDLE_TIMEOUT_SECONDS,
  resolveTimeoutSeconds,
  type ChatTimeouts,
} from "./openai/timeouts";
import type { OpenAIUsage } from "./openai/types";
import { reportNativeChatUsage } from "./nativeChatUsage";
import { httpError, parseRetryAfter, sanitizeErrorBody, toProviderError } from "./providerErrors";
import {
  DEFAULT_MAX_RETRIES,
  preStreamRetryError,
  resolveMaxRetries,
  RETRY_SETTING,
  retryDelayMs,
  waitForRetry,
} from "./retry";
import { sanitizeUpstreamText } from "./text";
import type { HttpEndpointAuthorizer } from "./httpEndpointGuard";
import type { UsageTracker } from "./usageTracker";
import type { DiscoveryFailure } from "./providerDiagnostics";
import {
  describeRoute,
  effortOverride,
  normalizeProfileIds,
  profileSecretName,
  readConfiguredCredential,
  resolveActiveProfile,
  resolveModelRoute,
  resolveModelRouteCandidates,
  type ModelRoute,
  type ProfileRouteSource,
  type ProfileSettings,
} from "./profiles";
import {
  FAILOVER_SETTING,
  ThrottleCooldowns,
  profileLabel,
  resolveFailoverEnabled,
  runWithFailover,
  type FailoverCandidate,
  type FailoverDiagnostics,
  type FailoverPlan,
  type ResolvedCredential,
} from "./failover";
import {
  MAX_ERROR_RESPONSE_BYTES,
  MAX_JSON_RESPONSE_BYTES,
  ResponseTooLargeError,
  readBoundedJson,
  readBoundedResponseText,
} from "./responseBody";

/**
 * Model-discovery failure raised at the HTTP boundary. The response body is
 * sanitized and bounded here, so downstream formatters only ever see
 * structural identifiers plus the status.
 */
export class ModelDiscoveryError extends Error implements DiscoveryFailure {
  constructor(
    message: string,
    readonly status?: number,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "ModelDiscoveryError";
  }
}

/**
 * Raised when the profile a request resolved to has no key in SecretStorage.
 * The message names the profile and is thrown at the single credential
 * boundary, before any gateway call is built.
 */
export class ProfileKeyMissingError extends Error {
  constructor(readonly profileId: string) {
    super(
      `NaN Builders profile "${profileId}" has no API key. Run 'NaN Builders: Manage Provider', open Profiles, and set the key for that profile.`,
    );
    this.name = "ProfileKeyMissingError";
  }
}

interface ModelListResponse {
  data?: DiscoveredModel[];
}

interface CachedModels {
  readonly expiresAt: number;
  readonly models: vscode.LanguageModelChatInformation[];
}

/** A chat key candidate: the routed key first, then the other profiles. */
interface ChatKeyCandidate extends FailoverCandidate {
  readonly primary: boolean;
}

/** A candidate's key plus the fingerprint the cooldowns are keyed by. */
interface ChatKey extends ResolvedCredential {
  readonly apiKey: string;
}

export class NanChatModelProvider implements vscode.LanguageModelChatProvider, vscode.Disposable {
  private readonly changedEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.changedEmitter.event;

  private cache: CachedModels | undefined;
  private nativeBaseUrl: string | undefined;
  private lastDiscoveryError: DiscoveryFailure | undefined;
  /** Conversations already warned about, so the trim warning appears once. */
  private readonly warnedTrimmedConversations = new Set<string>();
  /** Per-key cooldown applied by the opt-in throttle failover (#144). */
  private readonly cooldowns = new ThrottleCooldowns();

  constructor(
    private readonly context: Pick<vscode.ExtensionContext, "secrets">,
    private readonly usage: Pick<UsageTracker, "record">,
    private readonly endpointAuthorizer: HttpEndpointAuthorizer,
    /** Per-credential slots shared with inline completions. */
    private readonly slots: Pick<SlotQueueRegistry, "acquire">,
  ) {}

  dispose(): void {
    this.changedEmitter.dispose();
  }

  async provideLanguageModelChatInformation(
    options: { silent: boolean; configuration?: Record<string, unknown> },
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    diagnostic("models.provide.begin", {
      silent: options.silent,
      cancelled: token.isCancellationRequested,
      hasProviderConfiguration: options.configuration !== undefined,
    });
    if (token.isCancellationRequested) {
      diagnostic("models.provide.cancelled");
      return [];
    }

    // VS Code >= 1.146 passes the native "Manage Models" provider configuration
    // (declared in contributes.languageModelChatProviders.configuration) on every
    // call. Adopt it into the storage the rest of the extension already reads.
    const nativeApiKey = providerConfigString(options.configuration, "apiKey");
    const nativeBaseUrl = providerConfigString(options.configuration, "apiBaseUrl");
    if (nativeBaseUrl !== this.nativeBaseUrl) {
      this.nativeBaseUrl = nativeBaseUrl;
      this.cache = undefined;
    }
    if (nativeApiKey && nativeApiKey !== (await this.context.secrets.get(SECRET_API_KEY))) {
      await this.context.secrets.store(SECRET_API_KEY, nativeApiKey);
      this.cache = undefined;
      this.changedEmitter.fire();
    }

    const cached = this.cache;
    if (cached && cached.expiresAt > Date.now()) {
      diagnostic("models.provide.cacheHit", { modelCount: cached.models.length });
      return cached.models;
    }

    const apiKey = nativeApiKey ?? (await this.getDiscoveryApiKey(options.silent));
    if (!apiKey) {
      diagnostic("models.provide.noKey", { silent: options.silent });
      return [];
    }

    let models: DiscoveredModel[];
    let discoveryFailed = false;
    try {
      models = await this.fetchModelIds(apiKey, token);
      this.lastDiscoveryError = undefined;
    } catch (error) {
      if (isAbortError(error)) {
        return [];
      }
      discoveryFailed = true;
      this.lastDiscoveryError = toDiscoveryFailure(error);
      diagnostic("models.fetch.failed", {
        errorName: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message.slice(0, 200) : typeof error,
      });
      models = [];
    }
    const includeUnknown = vscode.workspace
      .getConfiguration("nanBuilders")
      .get<boolean>("includeUnknownModels", false);
    const discoveryMode = vscode.workspace
      .getConfiguration("nanBuilders")
      .get<string>("discoveryMode", "curated") === "auto" ? "auto" : "curated";

    // NaN documents /v1/models as the definitive, API-key-filtered list.
    // Only expose model IDs returned for this key. Known non-chat endpoints are
    // filtered out; unknown IDs are opt-in because a future non-chat endpoint
    // must not accidentally be advertised to VS Code as a chat model.
    const chatModels = filterDiscoveredModels(models, includeUnknown, discoveryMode);
    const vsCodeModels = chatModels.map((m) => this.toVsCodeModel(m));

    // Static catalog fallback (curated mode): if /v1/models fails or returns
    // no usable chat model, never leave the picker empty. The curated catalog
    // is served marked as not live-verified and is not cached, so the next
    // refresh retries the endpoint. Auto mode targets third-party servers,
    // where the NaN catalog would be misleading, so it keeps the live result.
    if (discoveryMode === "curated" && (discoveryFailed || vsCodeModels.length === 0)) {
      diagnostic("models.provide.staticFallback", { discoveryFailed, liveChatCount: vsCodeModels.length });
      return this.staticCatalogModels();
    }

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
    const modelConfiguration = (options as { modelConfiguration?: Record<string, unknown> }).modelConfiguration;
    // Single credential boundary: the profile (and therefore the key) is
    // resolved here, so a keyless profile fails with its name before any
    // gateway call, and the resolved key is what the slot queue fingerprints.
    const credential = await this.resolveCredential(
      model.id,
      providerConfigString(modelConfiguration, "apiKey"),
    );

    const toolMapping = convertTools(options.tools ?? [], options.toolMode === vscode.LanguageModelChatToolMode.Required);
    const history = convertMessages(
      messages.map((message) => ({
        role: message.role === vscode.LanguageModelChatMessageRole.User ? "user" : "assistant",
        content: message.content ?? [],
      })),
      toolMapping.originalToSanitized,
    );
    const trimmed = trimHistoryToBudget(history, this.inputBudgetTokens(model));
    if (trimmed.trimmed) {
      // Counts only: message content never reaches the diagnostic log.
      diagnostic("chat.history.trimmed", {
        modelId: model.id,
        unitCount: trimmed.unitCount,
        discardedUnits: trimmed.discardedUnits,
        tokensBefore: trimmed.tokensBefore,
        tokensAfter: trimmed.tokensAfter,
        fits: trimmed.fits,
      });
      this.warnHistoryTrimmed(historyConversationKey(history));
    }
    const openaiMessages = trimmed.messages;
    const requestBody: Record<string, unknown> = {
      model: model.id,
      messages: openaiMessages,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: model.maxOutputTokens || 4096,
    };

    if (toolMapping.definitions.length > 0) {
      requestBody.tools = toolMapping.definitions;
      requestBody.tool_choice = toolMapping.toolChoice ?? "auto";
    }

    // Fixed routing stays the default: one attempt with the resolved key and its
    // error unchanged. With `nanBuilders.failoverOnThrottle` on, a throttle
    // benches that key and retries the same logical request once on the next
    // profile that has its own key (#144).
    const plan = this.failoverPlan(model.id, credential);
    const completed = await runWithFailover(plan, this.cooldowns, async (candidate, resolved, index) => {
      if (index > 0) {
        // The first attempt is already logged by `resolveCredential`.
        diagnostic("chat.credential", {
          modelId: model.id,
          profile: profileLabel(candidate.profileId),
          profileSource: "failover",
          hasKey: true,
        });
      }
      const attemptBody: Record<string, unknown> = {
        ...requestBody,
        // NaN can spend several minutes in silent reasoning unless this is
        // bounded. The effort is remapped to the closest level the model
        // actually documents, for the profile serving this attempt.
        reasoning_effort: this.resolveEffort(model.id, options.modelOptions, candidate.profileId),
      };
      return this.streamChat(model, attemptBody, toolMapping, resolved.apiKey, progress, token, startedAt);
    });

    // Reported once for the whole request, never per attempt: the usage of the
    // attempt that finally settled it, which is the one the user paid for. A
    // retry or profile hop that never streamed reports nothing, and neither a
    // cancelled nor a truncated turn counts as a completed request.
    reportNativeChatUsage(completed.value, {
      enabled: vscode.workspace.getConfiguration("nanBuilders").get<boolean>("experimentalNativeChatUsage", false),
      version: vscode.version,
      cancelled: token.isCancellationRequested,
      // Deliberately opt-in: "usage" LanguageModelDataPart is not a stable VS Code API.
      DataPart: (vscode as unknown as {
        LanguageModelDataPart?: new (data: Uint8Array, mimeType: string) => vscode.LanguageModelResponsePart;
      }).LanguageModelDataPart,
      report: (part) => progress.report(part),
    });
  }

  /**
   * Sends one chat request with `apiKey` and streams the reply into `progress`.
   * Extracted from the chat entry point so the opt-in failover can repeat the
   * same logical request with another profile's key and its own slot.
   *
   * Returns the usage the provider reported for this attempt, so the caller can
   * emit the experimental native Chat usage once for the settled request. An
   * attempt that failed, was cancelled or was truncated reports nothing.
   */
  private async streamChat(
    model: vscode.LanguageModelChatInformation,
    requestBody: Record<string, unknown>,
    toolMapping: ReturnType<typeof convertTools>,
    apiKey: string,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
    startedAt: number,
  ): Promise<OpenAIUsage | undefined> {
    let timeoutController: ChatTimeoutController | undefined;
    let attempt: AttemptSignal | undefined;
    const cancellation = cancellationSignal(token, () => timeoutController?.settle());
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let slot: SlotLease | undefined;
    let chunkCount = 0;
    let lastUsage: OpenAIUsage | undefined;
    try {
      const sent = await this.sendChatWithRetries(model, requestBody, apiKey, token, cancellation.signal);
      timeoutController = sent.timeoutController;
      attempt = sent.attempt;
      slot = sent.slot;
      if (slot.waited) {
        diagnostic("chat.slot.queued", { modelId: model.id, waitedMs: Date.now() - startedAt });
      }
      const response = sent.response;
      diagnostic("chat.http.response", { modelId: model.id, status: response.status, elapsedMs: Date.now() - startedAt });
      if (!response.body) {
        throw new Error("NaN Builders returned an empty streaming response.");
      }

      reader = response.body.getReader();
      const textDecoder = new TextDecoder();
      const streamDecoder = new OpenAIStreamDecoder();
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
        timeoutController?.touch();
        chunkCount += 1;
        reportStreamEvents(streamDecoder.push(textDecoder.decode(value, { stream: true })));
      }

      timeoutController?.settle();
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
        return lastUsage;
      }
    } catch (error) {
      // A connect timeout now ends the retry loop by throwing the timer error
      // itself, so it is still reported as a timeout, not as a generic failure.
      const timeoutError =
        timeoutController?.timeoutError ??
        (error instanceof RequestTimeoutError ? error : undefined);
      if ((error instanceof StreamLimitError || timeoutError) && reader) {
        try {
          await reader.cancel(timeoutError ?? error);
        } catch (cancelError) {
          diagnostic("chat.stream.cancel.error", {
            modelId: model.id,
            errorName: cancelError instanceof Error ? cancelError.name : typeof cancelError,
          });
        }
      }
      const reported = timeoutError ?? error;
      diagnostic("chat.error", {
        modelId: model.id,
        elapsedMs: Date.now() - startedAt,
        errorName: reported instanceof Error ? reported.name : typeof reported,
        timedOut: Boolean(timeoutError),
        cancelled: token.isCancellationRequested,
      });
      // A timeout is always surfaced, even if the user canceled afterwards,
      // so an aborted signal is never reported as a plain cancellation.
      if (timeoutError) {
        throw timeoutError;
      }
      if (!token.isCancellationRequested && !isAbortError(error)) {
        // Transport failures (timeouts, DNS, refused connections) become
        // actionable messages here; application errors pass through unchanged.
        throw toProviderError(error);
      }
    } finally {
      // The slot covers the stream body too, so it is freed only once the
      // reader is done or cancelled, never on headers alone.
      slot?.release();
      timeoutController?.settle();
      attempt?.dispose();
      reader?.releaseLock();
      cancellation.dispose();
      diagnostic("chat.finally", {
        modelId: model.id,
        timedOut: Boolean(timeoutController?.timeoutError),
        cancelled: token.isCancellationRequested,
      });
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

    // Shares `src/openai/tokens.ts` with the history trimmer: images cost a flat
    // IMAGE_TOKENS each and tool-call names/arguments are counted as text.
    return countContentTokens(text.content ?? []);
  }

  /**
   * Input budget the model advertises, already reduced from the context window
   * by `toModelInfo`. Unknown or non-positive values disable trimming.
   */
  private inputBudgetTokens(model: vscode.LanguageModelChatInformation): number {
    const budget = model.maxInputTokens;
    return typeof budget === "number" && Number.isFinite(budget) && budget > 0
      ? Math.floor(budget)
      : Number.POSITIVE_INFINITY;
  }

  /** One interruption per conversation; later trims only reach the log. */
  private warnHistoryTrimmed(conversationKey: string): void {
    if (this.warnedTrimmedConversations.has(conversationKey)) {
      return;
    }
    // Bound the set so a long-lived window cannot accumulate keys forever.
    if (this.warnedTrimmedConversations.size >= 64) {
      this.warnedTrimmedConversations.clear();
    }
    this.warnedTrimmedConversations.add(conversationKey);
    void vscode.window.showWarningMessage(
      "NaN Builders trimmed the middle of this conversation to fit the model's input limit, keeping the first turn and the current request. " +
        "Start a new chat if the model needs those earlier details.",
    );
  }

  async setApiKey(apiKey: string): Promise<void> {
    await this.context.secrets.store(SECRET_API_KEY, apiKey.trim());
    this.refresh();
  }

  async clearApiKey(): Promise<void> {
    await this.context.secrets.delete(SECRET_API_KEY);
    this.refresh();
  }

  /** Stores one profile's key. Settings only ever hold profile ids. */
  async setProfileKey(profileId: string, apiKey: string): Promise<void> {
    await this.context.secrets.store(profileSecretName(profileId), apiKey.trim());
    this.refresh();
  }

  async clearProfileKey(profileId: string): Promise<void> {
    await this.context.secrets.delete(profileSecretName(profileId));
    this.refresh();
  }

  /** Moves a profile's key to its new id, never leaving two copies behind. */
  async renameProfileSecret(fromProfileId: string, toProfileId: string): Promise<void> {
    if (fromProfileId === toProfileId) {
      return;
    }
    const existing = await this.context.secrets.get(profileSecretName(fromProfileId));
    if (existing) {
      await this.context.secrets.store(profileSecretName(toProfileId), existing);
    } else {
      await this.context.secrets.delete(profileSecretName(toProfileId));
    }
    await this.context.secrets.delete(profileSecretName(fromProfileId));
    this.refresh();
  }

  async validateConfiguredKey(): Promise<number> {
    return (await this.probeConfiguredKey()).length;
  }

  /**
   * Silent model discovery for "Test Connection": reads the stored key
   * directly (never prompting for one) and returns the IDs it can reach.
   * Discovery is the only request sent - no chat completion is made.
   */
  async probeConfiguredKey(): Promise<string[]> {
    const { apiKey, profileId } = await this.configuredCredential();
    if (!apiKey) {
      throw profileId
        ? new ProfileKeyMissingError(profileId)
        : new Error("No NaN Builders API key is configured. Run 'NaN Builders: Manage Provider'.");
    }
    const source = new vscode.CancellationTokenSource();
    try {
      const models = await this.fetchModelIds(apiKey, source.token);
      this.lastDiscoveryError = undefined;
      return models.map((model) => model.id);
    } catch (error) {
      this.lastDiscoveryError = toDiscoveryFailure(error);
      throw error;
    } finally {
      source.dispose();
    }
  }

  /** Stored credential for the active profile, else the legacy shared key. */
  async configuredCredential(): Promise<{ apiKey: string | undefined; profileId: string | undefined }> {
    return readConfiguredCredential(
      this.profileSettings(),
      (name) => this.context.secrets.get(name),
      SECRET_API_KEY,
    );
  }

  /** Profiles are ids only; keys live in SecretStorage under a prefixed name. */
  profileSettings(): ProfileSettings {
    const configuration = vscode.workspace.getConfiguration("nanBuilders");
    return {
      profiles: normalizeProfileIds(configuration.get<unknown>("profiles", [])),
      activeProfile: configuration.get<string>("activeProfile", ""),
    };
  }

  private effortOverrides(): Record<string, unknown> {
    return vscode.workspace.getConfiguration("nanBuilders").get<Record<string, unknown>>("reasoningEffortByModel", {}) ?? {};
  }

  /** Profile a model's requests resolve to, with its provenance. */
  modelRoute(modelId: string): ModelRoute {
    return resolveModelRoute(this.profileSettings(), this.effortOverrides(), modelId);
  }

  /** `nanBuilders.failoverOnThrottle`; off unless the user opted in. */
  failoverEnabled(): boolean {
    return resolveFailoverEnabled(
      vscode.workspace.getConfiguration("nanBuilders").get<unknown>(FAILOVER_SETTING, false),
    );
  }

  /** Cooldown state for *Show Diagnostics*: profile ids and seconds only. */
  failoverState(): FailoverDiagnostics {
    return { enabled: this.failoverEnabled(), cooling: this.cooldowns.snapshot(Date.now()) };
  }

  /** Drops every cooldown; turning the setting off must not leave keys benched. */
  clearCooldowns(): void {
    this.cooldowns.clear();
  }

  /**
   * Key candidates for one chat request. The key `resolveCredential` already
   * read comes first; the remaining configured profiles follow in settings
   * order and are read lazily, so a request that never hops never touches
   * another profile's secret. A native per-model key never hops: the user chose
   * it for that model, and retrying elsewhere would spend a different account.
   */
  private failoverPlan(
    modelId: string,
    primary: { apiKey: string; profileId: string | undefined; source: ProfileRouteSource | "native" },
  ): FailoverPlan<ChatKeyCandidate, ChatKey> {
    const routed: ChatKeyCandidate = { profileId: primary.profileId, primary: true };
    const candidates: ChatKeyCandidate[] = [routed];
    if (primary.source !== "native") {
      for (const route of resolveModelRouteCandidates(this.profileSettings(), this.effortOverrides(), modelId)) {
        if (route.profileId !== primary.profileId) {
          candidates.push({ profileId: route.profileId, primary: false });
        }
      }
    }
    return {
      enabled: this.failoverEnabled(),
      candidates,
      resolve: async (candidate) => {
        if (candidate.primary) {
          return { apiKey: primary.apiKey, credentialId: credentialId(primary.apiKey) };
        }
        if (!candidate.profileId) {
          return undefined;
        }
        const stored = await this.profileKey(candidate.profileId);
        return stored ? { apiKey: stored, credentialId: credentialId(stored) } : undefined;
      },
      onHop: (hop) =>
        diagnostic("chat.failover", {
          modelId,
          from: profileLabel(hop.from.profileId),
          to: profileLabel(hop.to.profileId),
          reason: hop.reason,
          cooldownSeconds: hop.cooldownSeconds,
        }),
    };
  }

  /**
   * The one place a profile key is read: SecretStorage, under its prefixed
   * name. Kept as a helper so the failover retry reads a candidate's key
   * through the same boundary as the routed one.
   */
  private async profileKey(profileId: string): Promise<string | undefined> {
    return this.context.secrets.get(profileSecretName(profileId));
  }

  /**
   * Resolves the key one chat request uses. A native per-model configuration
   * wins (VS Code "Manage Models"); otherwise `profile::model` routing and the
   * active profile decide, and the legacy shared key remains the fallback when
   * no profile is configured.
   */
  private async resolveCredential(
    modelId: string,
    nativeApiKey: string | undefined,
  ): Promise<{
    apiKey: string;
    profileId: string | undefined;
    source: ProfileRouteSource | "native";
  }> {
    if (nativeApiKey) {
      diagnostic("chat.credential", { modelId, source: "native" });
      return { apiKey: nativeApiKey, profileId: undefined, source: "native" };
    }
    const route = this.modelRoute(modelId);
    if (!route.profileId) {
      const apiKey = await this.getApiKey(false);
      if (!apiKey) {
        diagnostic("chat.noKey", { modelId, source: route.source });
        throw new Error("NaN Builders API key is not configured. Run 'NaN Builders: Manage Provider'.");
      }
      diagnostic("chat.credential", { modelId, source: route.source });
      return { apiKey, profileId: undefined, source: route.source };
    }
    const apiKey = await this.profileKey(route.profileId);
    diagnostic("chat.credential", { modelId, ...describeRoute(route), hasKey: Boolean(apiKey) });
    if (!apiKey) {
      throw new ProfileKeyMissingError(route.profileId);
    }
    return { apiKey, profileId: route.profileId, source: route.source };
  }

  /** Discovery credential: active profile key when profiles exist, else legacy. */
  private async getDiscoveryApiKey(silent: boolean): Promise<string | undefined> {
    const settings = this.profileSettings();
    const activeProfile = resolveActiveProfile(settings);
    if (!activeProfile) {
      diagnostic("models.provide.legacyKey");
      return this.getApiKey(silent);
    }
    const stored = await this.context.secrets.get(profileSecretName(activeProfile));
    diagnostic("models.provide.profile", { profile: activeProfile, hasKey: Boolean(stored) });
    if (stored || silent) {
      return stored;
    }
    const entered = await this.promptForKey(
      `NaN Builders profile "${activeProfile}" API Key`,
      `Paste the API key for profile "${activeProfile}". It is stored in VS Code SecretStorage.`,
    );
    if (!entered) {
      return undefined;
    }
    await this.setProfileKey(activeProfile, entered);
    return entered;
  }

  private async promptForKey(title: string, prompt: string): Promise<string | undefined> {
    const entered = await vscode.window.showInputBox({
      title,
      prompt,
      password: true,
      ignoreFocusOut: true,
      placeHolder: "sk-...",
    });
    const trimmed = entered?.trim();
    return trimmed ? trimmed : undefined;
  }

  private async getApiKey(silent: boolean): Promise<string | undefined> {
    let apiKey = await this.context.secrets.get(SECRET_API_KEY);
    if (apiKey || silent) {
      return apiKey;
    }

    const entered = await this.promptForKey(
      "NaN Builders API Key",
      "Paste your NaN Builders API key. It will be stored in VS Code SecretStorage.",
    );
    if (!entered) {
      return undefined;
    }

    apiKey = entered;
    await this.setApiKey(apiKey);
    return apiKey;
  }

  /** Endpoint used for discovery, chat, and usage; native provider configuration wins. */
  getBaseUrl(): string {
    return this.apiBaseUrl();
  }

  /** Model IDs tracked locally: the warm discovery cache, else the curated catalog. */
  trackedModelIds(): string[] {
    return this.cache?.models.map((model) => model.id) ?? knownChatModelIds();
  }

  /** Last model-discovery failure; already stripped of response bodies. */
  discoveryError(): DiscoveryFailure | undefined {
    return this.lastDiscoveryError;
  }

  refresh(): void {
    this.cache = undefined;
    this.changedEmitter.fire();
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
        const detail = await readDiscoveryFailureDetail(response);
        if (response.status === 401 || response.status === 403) {
          throw new ModelDiscoveryError(
            `NaN Builders rejected the API key (HTTP ${response.status}). Update it with 'NaN Builders: Manage Provider'.`,
            response.status,
            detail,
          );
        }
        throw new ModelDiscoveryError(
          `Unable to discover NaN Builders models: HTTP ${response.status} ${sanitizeUpstreamText(response.statusText, 200)}`,
          response.status,
          detail,
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

  /**
   * Sends one chat request, retrying transient failures that happen before the
   * response body is handed out (#151): a throttle 429 with `Retry-After`,
   * 5xx gateway errors, connect timeouts, and network errors. Nothing is
   * retried once streaming has started.
   *
   * Retries stay on the same key and are counted per profile attempt, so the
   * retry budget is what runs out before the opt-in failover (#144) may hop.
   */
  private async sendChatWithRetries(
    model: vscode.LanguageModelChatInformation,
    requestBody: Record<string, unknown>,
    apiKey: string,
    token: vscode.CancellationToken,
    cancellation: AbortSignal,
  ): Promise<{
    response: Response;
    slot: SlotLease;
    timeoutController: ChatTimeoutController;
    attempt: AttemptSignal;
  }> {
    const maxRetries = this.maxRetries();
    const timeouts = this.chatTimeouts();
    for (let retry = 0; ; retry += 1) {
      // Every attempt owns its abort signal and timers: an aborted signal can
      // never be reused, and a fired connect timer must not poison the next
      // attempt with a stale timeout error.
      const attempt = linkedSignal(cancellation);
      const timeoutController = new ChatTimeoutController(timeouts, (reason) => attempt.abort(reason));
      if (token.isCancellationRequested) {
        timeoutController.settle();
      }
      try {
        // oxlint-disable-next-line eslint/no-await-in-loop
        const sent = await this.sendChatRequest(apiKey, requestBody, attempt.signal, timeoutController);
        return { ...sent, timeoutController, attempt };
      } catch (error) {
        const failure = timeoutController.timeoutError ?? error;
        timeoutController.settle();
        attempt.dispose();
        const retryable = preStreamRetryError(failure);
        if (retry >= maxRetries || !retryable || token.isCancellationRequested) {
          throw failure;
        }
        const delayMs = retryDelayMs({
          attempt: retry + 1,
          retryAfterSeconds: retryable.retryAfterSeconds,
        });
        diagnostic("chat.retry", {
          modelId: model.id,
          attempt: retry + 1,
          maxRetries,
          delayMs,
          code: retryable.code,
        });
        // The failed send already released its slot, so a backoff holds no
        // per-key capacity: another request can use the key while this one
        // waits, and cancellation rejects the wait instead of taking a slot.
        // oxlint-disable-next-line eslint/no-await-in-loop
        await waitForRetry(delayMs, cancellation);
      }
    }
  }

  private async sendChatRequest(
    apiKey: string,
    body: Record<string, unknown>,
    signal: AbortSignal,
    timeouts: ChatTimeoutController,
  ): Promise<{ response: Response; slot: SlotLease }> {
    const baseUrl = this.apiBaseUrl();
    // Each send arms its own headers deadline *after* authorization, so endpoint
    // consent never counts against it, and each send clears whatever timer the
    // previous request or its error body left running before starting.
    const send = async (requestBody: Record<string, unknown>): Promise<Response> => {
      timeouts.armConnect();
      const response = await fetch(`${baseUrl}/chat/completions`, {
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
      // Headers are in: the remaining time is body time, not connect time.
      timeouts.startStream();
      return response;
    };

    await this.endpointAuthorizer.authorize(baseUrl, signal);
    // One slot per send attempt covers the compatibility fallback re-send too:
    // the failed response is drained before the retry, so only one request is
    // ever in flight against the gateway for this lease.
    const slot = await this.slots.acquire(apiKey, signal);
    try {
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
          throw httpError(
            response.status,
            response.statusText,
            text,
            parseRetryAfter(response.headers.get("Retry-After")),
          );
        }
      }

      if (!response.ok) {
        const text = await readChatErrorText(response);
        throw httpError(
          response.status,
          response.statusText,
          text,
          parseRetryAfter(response.headers.get("Retry-After")),
        );
      }
      return { response, slot };
    } catch (error) {
      // Failures and cancellations release here; the caller releases once it
      // has drained the stream body.
      slot.release();
      throw error;
    }
  }

  private chatTimeouts(): ChatTimeouts {
    const configuration = vscode.workspace.getConfiguration("nanBuilders");
    return {
      connectTimeoutSeconds: resolveTimeoutSeconds(
        configuration.get<number>("connectTimeoutSeconds", DEFAULT_CONNECT_TIMEOUT_SECONDS),
        DEFAULT_CONNECT_TIMEOUT_SECONDS,
      ),
      streamIdleTimeoutSeconds: resolveTimeoutSeconds(
        configuration.get<number>("streamIdleTimeoutSeconds", DEFAULT_STREAM_IDLE_TIMEOUT_SECONDS),
        DEFAULT_STREAM_IDLE_TIMEOUT_SECONDS,
      ),
    };
  }

  /** `nanBuilders.maxRetries`, where `0` restores the pre-#151 behavior. */
  private maxRetries(): number {
    return resolveMaxRetries(
      vscode.workspace.getConfiguration("nanBuilders").get<number>(RETRY_SETTING, DEFAULT_MAX_RETRIES),
    );
  }

  private apiBaseUrl(): string {
    return (
      this.nativeBaseUrl ??
      vscode.workspace
        .getConfiguration("nanBuilders")
        .get<string>("apiBaseUrl", DEFAULT_API_BASE_URL)
    ).replace(/\/+$/, "");
  }

  private userAgent(): string {
    const extension = vscode.extensions.getExtension("svg153.nan-builders-vscode");
    const version = extension?.packageJSON?.version ?? "dev";
    return `nan-vscode/${version} VSCode/${vscode.version}`;
  }

  /** Effective reasoning effort for a model, honoring per-model overrides. */
  private resolveEffort(
    modelId: string,
    modelOptions: { readonly [name: string]: unknown } | undefined,
    profileId?: string,
  ): string {
    const configuration = vscode.workspace.getConfiguration("nanBuilders");
    const overrides = configuration.get<Record<string, unknown>>("reasoningEffortByModel", {});
    const routeProfile = profileId ?? resolveActiveProfile(this.profileSettings());
    const perModel = effortOverride(overrides, modelId, routeProfile);
    const requested = typeof modelOptions?.reasoning_effort === "string" ? modelOptions.reasoning_effort : undefined;
    return resolveReasoningEffort({
      requested,
      perModelOverride: perModel,
      globalDefault: configuration.get<string>("defaultReasoningEffort", "auto"),
      ladder: getKnownModel(modelId)?.reasoningEffortValues,
    });
  }

  private toVsCodeModel(discovered: DiscoveredModel): vscode.LanguageModelChatInformation {
    return this.toModelInfo(toDisplayMetadata(discovered.id, discovered));
  }

  /** Curated catalog served when live discovery failed or returned nothing usable. */
  private staticCatalogModels(): vscode.LanguageModelChatInformation[] {
    return knownChatModelIds().map((id) => this.toModelInfo(toDisplayMetadata(id), true));
  }

  private toModelInfo(metadata: ModelMetadata, unverified = false): vscode.LanguageModelChatInformation {
    const known = getKnownModel(metadata.id);
    // Reserve a 10% input budget margin against tokenizer divergence: a
    // full-context request can still 400 when the server tokenizes differently.
    const inputBudget = Math.min(
      metadata.contextWindow - metadata.maxOutputTokens,
      Math.floor(metadata.contextWindow * 0.9),
    );
    return {
      id: metadata.id,
      name: metadata.largerModel ? `${metadata.name} (larger model)` : metadata.name,
      family: metadata.id,
      version: "1",
      maxInputTokens: Math.max(1, inputBudget),
      maxOutputTokens: metadata.maxOutputTokens,
      detail: unverified ? "NaN Builders - not live-verified" : known ? "NaN Builders" : "NaN Builders - metadata unknown",
      tooltip: [
        unverified
          ? `Static NaN Builders catalog (${metadata.name}); live model discovery failed or returned no chat models. Access is not verified for the current API key.`
          : known
            ? `NaN Builders hosted ${metadata.name}`
            : metadata.toolCalling
              ? "Auto-discovered from the configured endpoint. Capabilities come from endpoint metadata."
              : "Auto-discovered from the configured endpoint. Tool calling is disabled until metadata is known.",
        billingDescription(metadata),
        reasoningDescription(metadata),
        ...(known?.reasoningEffortValues?.length ? [`Current effort: ${this.resolveEffort(metadata.id, undefined)}.`] : []),
      ].join("\n"),
      capabilities: {
        imageInput: metadata.imageInput,
        toolCalling: metadata.toolCalling,
      },
    };
  }
}

/** Reads a non-empty trimmed string from the native provider `configuration` payload. */
function providerConfigString(configuration: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = configuration?.[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

interface AttemptSignal {
  readonly signal: AbortSignal;
  readonly abort: (reason?: unknown) => void;
  readonly dispose: () => void;
}

function cancellationSignal(
  token: vscode.CancellationToken,
  onCancel?: () => void,
): { signal: AbortSignal; abort: (reason?: unknown) => void; dispose: () => void } {
  const controller = new AbortController();
  const abort = (reason?: unknown): void => controller.abort(reason);
  if (token.isCancellationRequested) {
    onCancel?.();
    controller.abort();
    return { signal: controller.signal, abort, dispose: () => {} };
  }
  const listener = token.onCancellationRequested(() => {
    onCancel?.();
    controller.abort();
  });
  return { signal: controller.signal, abort, dispose: () => listener.dispose() };
}

/**
 * A per-attempt abort signal that follows the request-wide cancellation but can
 * also be aborted on its own by that attempt's connect timer. Aborting the
 * attempt never aborts the request, which is what lets the next retry run.
 */
function linkedSignal(parent: AbortSignal): AttemptSignal {
  const controller = new AbortController();
  const abort = (reason?: unknown): void => controller.abort(reason);
  if (parent.aborted) {
    abort(parent.reason);
    return { signal: controller.signal, abort, dispose: () => {} };
  }
  const forward = (): void => abort(parent.reason);
  parent.addEventListener("abort", forward, { once: true });
  return {
    signal: controller.signal,
    abort,
    dispose: () => parent.removeEventListener("abort", forward),
  };
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

/**
 * Reads a bounded discovery failure body and reduces it to safe structural
 * identifiers. Nothing from the body leaves this function unsanitized, and an
 * unreadable or oversized body still leaves the HTTP status intact.
 */
async function readDiscoveryFailureDetail(response: Response): Promise<string | undefined> {
  try {
    const body = await readBoundedResponseText(response, MAX_ERROR_RESPONSE_BYTES);
    return sanitizeErrorBody(body) || undefined;
  } catch {
    return undefined;
  }
}

function toDiscoveryFailure(error: unknown): DiscoveryFailure {
  return error instanceof ModelDiscoveryError ? error : {};
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
