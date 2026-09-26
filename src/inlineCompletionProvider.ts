import * as vscode from "vscode";
import { DEFAULT_API_BASE_URL, SECRET_API_KEY } from "./constants";
import { diagnostic } from "./diagnostics";
import { buildCompletionRequest, requestInlineCompletion } from "./inlineCompletion";

/**
 * Opt-in inline ghost-text completions through the legacy `POST /completions`
 * endpoint. Off unless `nanBuilders.completionModel` is set; never shows stale
 * text because every failure returns `undefined`.
 */
export class NanInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    try {
      const model = vscode.workspace
        .getConfiguration("nanBuilders")
        .get<string>("completionModel", "")
        .trim();
      if (!model || token.isCancellationRequested) {
        return undefined;
      }
      const apiKey = await this.secrets.get(SECRET_API_KEY);
      if (!apiKey || token.isCancellationRequested) {
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

      // Register the listener before any further check so a cancellation in the
      // gap cannot be missed (the token returns no-op events once cancelled);
      // re-check and abort for cancellations that already happened.
      const controller = new AbortController();
      const cancellation = token.onCancellationRequested(() => controller.abort());
      if (token.isCancellationRequested) {
        controller.abort();
      }
      try {
        const outcome = await requestInlineCompletion({
          baseUrl: vscode.workspace
            .getConfiguration("nanBuilders")
            .get<string>("apiBaseUrl", DEFAULT_API_BASE_URL),
          apiKey,
          userAgent: userAgent(),
          request,
          signal: controller.signal,
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
        if (!outcome.ok || controller.signal.aborted || token.isCancellationRequested) {
          return undefined;
        }
        return [{ insertText: outcome.text, range: new vscode.Range(position, position) }];
      } finally {
        cancellation.dispose();
      }
    } catch (error) {
      diagnostic("inline.error", { message: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
  }
}

function userAgent(): string {
  const extension = vscode.extensions.getExtension("svg153.nan-builders-vscode");
  const version = extension?.packageJSON?.version ?? "dev";
  return `nan-vscode/${version} VSCode/${vscode.version}`;
}
