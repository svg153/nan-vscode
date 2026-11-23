import * as vscode from "vscode";
import { isCompletionExcluded } from "./completionExclusions";
import { DEFAULT_API_BASE_URL, SECRET_API_KEY } from "./constants";
import { diagnostic } from "./diagnostics";
import type { HttpEndpointAuthorizer } from "./httpEndpointGuard";
import {
  buildCompletionRequest,
  recordCompletionUsage,
  requestInlineCompletion,
  waitForInlineCompletionDebounce,
} from "./inlineCompletion";
import type { SlotQueueRegistry } from "./openai/slotQueue";
import { describeRoute, normalizeProfileIds, profileSecretName, resolveModelRoute } from "./profiles";
import type { UsageTracker } from "./usageTracker";

/**
 * Opt-in inline ghost-text completions through the legacy `POST /completions`
 * endpoint. Off unless `nanBuilders.completionModel` is set; never shows stale
 * text because every failure returns `undefined`.
 */
export class NanInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  private activeRequest?: AbortController;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly endpointAuthorizer: HttpEndpointAuthorizer,
    /** Slots shared with chat so both paths respect one per-key limit. */
    private readonly slots: Pick<SlotQueueRegistry, "acquire">,
    /** Local usage history shared with chat; counts and model IDs only. */
    private readonly usage: Pick<UsageTracker, "record">,
  ) {}

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    this.activeRequest?.abort();
    const configuration = vscode.workspace.getConfiguration("nanBuilders");
    // Checked before any request, queue slot, or usage record so an excluded
    // document costs nothing and stays silent while typing.
    if (
      isCompletionExcluded({
        languageId: document.languageId,
        filePath: document.uri.fsPath,
        excludedLanguages: configuration.get<string[]>("completionExcludedLanguages"),
        excludedGlobs: configuration.get<string[]>("completionExcludedGlobs"),
      })
    ) {
      diagnostic("inline.excluded");
      return undefined;
    }
    const controller = new AbortController();
    this.activeRequest = controller;
    const cancellation = token.onCancellationRequested(() => controller.abort());
    if (token.isCancellationRequested) {
      controller.abort();
    }

    try {
      if (controller.signal.aborted) {
        return undefined;
      }
      const model = configuration.get<string>("completionModel", "").trim();
      if (!model || controller.signal.aborted) {
        return undefined;
      }
      const apiKey = await this.completionApiKey(model);
      if (!apiKey || controller.signal.aborted) {
        return undefined;
      }
      const request = buildCompletionRequest({
        model,
        documentText: document.getText(),
        cursorOffset: document.offsetAt(position),
      });
      if (!request) {
        return undefined;
      }

      if (!(await waitForInlineCompletionDebounce(controller.signal))) {
        return undefined;
      }

      const outcome = await requestInlineCompletion({
        baseUrl: configuration.get<string>("apiBaseUrl", DEFAULT_API_BASE_URL),
        apiKey,
        userAgent: userAgent(),
        request,
        signal: controller.signal,
        endpointAuthorizer: this.endpointAuthorizer,
        slotQueues: this.slots,
      });
      diagnostic(
        "inline.complete",
        outcome.ok
          ? { ok: true }
          : {
              ok: false,
              reason: outcome.reason,
              ...(outcome.status !== undefined ? { status: outcome.status } : {}),
            },
      );
      if (
        !outcome.ok ||
        controller.signal.aborted ||
        token.isCancellationRequested ||
        this.activeRequest !== controller
      ) {
        return undefined;
      }
      // Fire-and-forget: a local memento write must never delay the ghost text
      // or race the next trigger, and `recordCompletionUsage` never throws.
      void recordCompletionUsage(this.usage, model, outcome);
      return [{ insertText: outcome.text, range: new vscode.Range(position, position) }];
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return undefined;
      }
      diagnostic("inline.error", { errorName: error instanceof Error ? error.name : typeof error });
      return undefined;
    } finally {
      cancellation.dispose();
      if (this.activeRequest === controller) {
        this.activeRequest = undefined;
      }
    }
  }

  /**
   * Key for the configured completion model: its `profile::model` assignment
   * wins, else the active profile, else the legacy shared key. Inline ghost text
   * never raises a notification, so a missing profile key only logs here; the
   * chat entry check is what names the profile to the user.
   */
  private async completionApiKey(model: string): Promise<string | undefined> {
    const configuration = vscode.workspace.getConfiguration("nanBuilders");
    const route = resolveModelRoute(
      {
        profiles: normalizeProfileIds(configuration.get<unknown>("profiles", [])),
        activeProfile: configuration.get<string>("activeProfile", ""),
      },
      configuration.get<Record<string, unknown>>("reasoningEffortByModel", {}) ?? {},
      model,
    );
    const apiKey = await this.secrets.get(
      route.profileId ? profileSecretName(route.profileId) : SECRET_API_KEY,
    );
    diagnostic("inline.credential", { model, ...describeRoute(route), hasKey: Boolean(apiKey) });
    return apiKey;
  }
}

function userAgent(): string {
  const extension = vscode.extensions.getExtension("svg153.nan-builders-vscode");
  const version = extension?.packageJSON?.version ?? "dev";
  return `nan-vscode/${version} VSCode/${vscode.version}`;
}
