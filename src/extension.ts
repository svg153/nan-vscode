import * as vscode from "vscode";
import { NAN_DASHBOARD_URL, NAN_DOCS_URL, PROVIDER_VENDOR, SECRET_API_KEY } from "./constants";
import { configureDiagnosticFile, diagnostic } from "./diagnostics";
import { NanChatModelProvider } from "./provider";
import { UsageTracker } from "./usageTracker";

export function activate(context: vscode.ExtensionContext): {
  setTestApiKey(key: string): Promise<void>;
  clearTestApiKey(): Promise<void>;
} | undefined {
  configureDiagnosticFile(context.logUri.fsPath);
  diagnostic("activate.begin", {
    version: String(context.extension.packageJSON.version ?? "unknown"),
    vscodeVersion: vscode.version,
    extensionMode: context.extensionMode,
    remoteName: vscode.env.remoteName ?? "local",
  });
  const heartbeat = setInterval(() => diagnostic("heartbeat"), 5_000);
  heartbeat.unref();
  context.subscriptions.push({ dispose: () => clearInterval(heartbeat) });

  const usage = new UsageTracker();
  diagnostic("activate.usageTracker.created");
  const provider = new NanChatModelProvider(context, usage);
  diagnostic("activate.provider.created");

  context.subscriptions.push(
    usage,
    provider,
    vscode.lm.registerLanguageModelChatProvider(PROVIDER_VENDOR, provider),
    vscode.commands.registerCommand("nanBuilders.manage", () => manageProvider(context, provider)),
    vscode.commands.registerCommand("nanBuilders.refreshModels", async () => {
      provider.refresh();
      vscode.window.showInformationMessage("NaN Builders model list refreshed.");
    }),
    vscode.commands.registerCommand("nanBuilders.showUsage", async () => {
      await vscode.window.showInformationMessage(usage.summary(), { modal: true });
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("nanBuilders")) {
        provider.refresh();
        usage.refreshVisibility();
      }
    }),
  );
  diagnostic("activate.complete", { subscriptionCount: context.subscriptions.length });

  // Expose only a narrow setup hook to the isolated VS Code integration test.
  return context.extensionMode === vscode.ExtensionMode.Test
    ? {
        setTestApiKey: (key) => provider.setApiKey(key),
        clearTestApiKey: () => provider.clearApiKey(),
      }
    : undefined;
}

async function manageProvider(
  context: vscode.ExtensionContext,
  provider: NanChatModelProvider,
): Promise<void> {
  const existing = await context.secrets.get(SECRET_API_KEY);

  type Action = "set" | "validate" | "clear" | "dashboard" | "docs";
  const items: Array<vscode.QuickPickItem & { action: Action }> = [
    {
      label: "$(key) Set or replace API key",
      description: existing ? "A key is currently configured" : "No key configured",
      action: "set",
    },
    {
      label: "$(check) Validate API key and refresh models",
      description: existing ? "Check the current key against /v1/models" : "Configure a key first",
      action: "validate",
    },
    {
      label: "$(link-external) Open NaN Builders dashboard",
      action: "dashboard",
    },
    {
      label: "$(book) Open NaN Builders documentation",
      action: "docs",
    },
  ];

  if (existing) {
    items.splice(2, 0, {
      label: "$(trash) Clear API key",
      description: "Remove it from VS Code SecretStorage",
      action: "clear",
    });
  }

  const choice = await vscode.window.showQuickPick(items, {
    title: "NaN Builders",
    placeHolder: "Manage the VS Code language model provider",
  });
  if (!choice) {
    return;
  }

  switch (choice.action) {
    case "set": {
      const value = await vscode.window.showInputBox({
        title: "NaN Builders API Key",
        prompt: "Paste your API key. It is stored in VS Code SecretStorage.",
        password: true,
        ignoreFocusOut: true,
        placeHolder: "sk-...",
      });
      if (!value?.trim()) {
        return;
      }
      await provider.setApiKey(value.trim());
      try {
        const count = await provider.validateConfiguredKey();
        vscode.window.showInformationMessage(`NaN Builders API key saved. ${count} model IDs are currently available to this API key.`);
      } catch (error) {
        vscode.window.showErrorMessage(errorMessage(error));
      }
      return;
    }
    case "validate": {
      try {
        const count = await provider.validateConfiguredKey();
        provider.refresh();
        vscode.window.showInformationMessage(`NaN Builders API key is valid. ${count} model IDs are currently available to this API key.`);
      } catch (error) {
        vscode.window.showErrorMessage(errorMessage(error));
      }
      return;
    }
    case "clear":
      await provider.clearApiKey();
      vscode.window.showInformationMessage("NaN Builders API key removed from VS Code SecretStorage.");
      return;
    case "dashboard":
      await vscode.env.openExternal(vscode.Uri.parse(NAN_DASHBOARD_URL));
      return;
    case "docs":
      await vscode.env.openExternal(vscode.Uri.parse(NAN_DOCS_URL));
      return;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function deactivate(): void {}
