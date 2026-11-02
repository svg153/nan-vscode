import * as vscode from "vscode";
import { DEFAULT_API_BASE_URL, SECRET_API_KEY } from "./constants";
import { diagnostic } from "./diagnostics";
import type { HttpEndpointAuthorizer } from "./httpEndpointGuard";
import {
  buildCompletionRequest,
  requestInlineCompletion,
  waitForInlineCompletionDebounce,
} from "./inlineCompletion";

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
  ) {}

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    this.activeRequest?.abort();
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
      const model = vscode.workspace
        .getConfiguration("nanBuilders")
        .get<string>("completionModel", "")
        .trim();
      if (!model || controller.signal.aborted) {
        return undefined;
      }
      const apiKey = await this.secrets.get(SECRET_API_KEY);
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
        baseUrl: vscode.workspace
          .getConfiguration("nanBuilders")
          .get<string>("apiBaseUrl", DEFAULT_API_BASE_URL),
        apiKey,
        userAgent: userAgent(),
        request,
        signal: controller.signal,
        endpointAuthorizer: this.endpointAuthorizer,
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
}

function userAgent(): string {
  const extension = vscode.extensions.getExtension("svg153.nan-builders-vscode");
  const version = extension?.packageJSON?.version ?? "dev";
  return `nan-vscode/${version} VSCode/${vscode.version}`;
}
