import * as vscode from "vscode";
import { NAN_DASHBOARD_URL, NAN_DOCS_URL, PROVIDER_VENDOR, SECRET_API_KEY, DEFAULT_API_BASE_URL } from "./constants";
import { configureDiagnosticFile, diagnostic } from "./diagnostics";
import { NanChatModelProvider } from "./provider";
import { AccountUsageService, accountModelRows } from "./accountUsage";
import { compactTokens } from "./quotaCatalog";
import { API_REQUESTS_CUTOFF_DATE } from "./usageApi";
import { UsageTracker } from "./usageTracker";

export function activate(context: vscode.ExtensionContext): {
  setTestApiKey(key: string): Promise<void>;
  clearTestApiKey(): Promise<void>;
  readTestUsageHistory(): unknown;
  clearTestUsageHistory(): Promise<boolean>;
} | undefined {
  const diagnosticsEnabled = vscode.workspace
    .getConfiguration("nanBuilders")
    .get<boolean>("diagnostics.enabled", false);
  configureDiagnosticFile(context.logUri.fsPath, diagnosticsEnabled);
  if (diagnosticsEnabled) {
    diagnostic("activate.begin", {
      version: String(context.extension.packageJSON.version ?? "unknown"),
      vscodeVersion: vscode.version,
      extensionMode: context.extensionMode,
      remoteName: vscode.env.remoteName ?? "local",
    });
    const heartbeat = setInterval(() => diagnostic("heartbeat"), 5_000);
    heartbeat.unref();
    context.subscriptions.push({ dispose: () => clearInterval(heartbeat) });
  }

  const account = new AccountUsageService(async () => {
    const apiKey = await context.secrets.get(SECRET_API_KEY);
    if (!apiKey) {
      return undefined;
    }
    return {
      baseUrl: vscode.workspace
        .getConfiguration("nanBuilders")
        .get<string>("apiBaseUrl", DEFAULT_API_BASE_URL)
        .replace(/\/+$/, ""),
      apiKey,
    };
  });
  const usage = new UsageTracker(context.globalState, account);
  diagnostic("activate.usageTracker.created");
  const provider = new NanChatModelProvider(context, usage);
  diagnostic("activate.provider.created");

  const refreshAccountUsage = async (options: { force?: boolean; manual?: boolean } = {}): Promise<void> => {
    try {
      await account.refresh({ force: options.force ?? false });
    } catch (error) {
      // Background failures stay in diagnostics + tooltip; only manual refreshes toast.
      diagnostic("refreshAccountUsage.error", { message: errorMessage(error) });
      if (options.manual) {
        vscode.window.showErrorMessage(errorMessage(error));
      }
    } finally {
      usage.accountUpdated();
    }
  };

  context.subscriptions.push(
    usage,
    provider,
    vscode.lm.registerLanguageModelChatProvider(PROVIDER_VENDOR, provider),
    vscode.commands.registerCommand("nanBuilders.manage", () => manageProvider(context, provider, refreshAccountUsage)),
    vscode.commands.registerCommand("nanBuilders.refreshModels", async () => {
      provider.refresh();
      vscode.window.showInformationMessage("NaN Builders model list refreshed.");
    }),
    vscode.commands.registerCommand("nanBuilders.showUsage", () => {
      const picker = vscode.window.createQuickPick<vscode.QuickPickItem>();
      picker.title = "NaN Builders usage";
      picker.placeholder = "Account-wide usage, published quotas, and this extension's local history.";
      picker.matchOnDescription = true;
      picker.matchOnDetail = true;
      const buildItems = (): vscode.QuickPickItem[] => [
        ...accountItems(account),
        { kind: vscode.QuickPickItemKind.Separator, label: "Published quotas (local session)" },
        ...usage.quotaItems(),
        { kind: vscode.QuickPickItemKind.Separator, label: "Recent local daily history" },
        ...usage.historyItems(),
      ];
      picker.items = buildItems();
      picker.buttons = [
        { iconPath: new vscode.ThemeIcon("refresh"), tooltip: "Refresh account usage" },
        { iconPath: new vscode.ThemeIcon("trash"), tooltip: "Clear local usage history" },
        { iconPath: new vscode.ThemeIcon("gear"), tooltip: "Manage provider (API key)" },
        { iconPath: new vscode.ThemeIcon("globe"), tooltip: "Open NaN Builders dashboard" },
      ];
      picker.onDidTriggerButton(async (button) => {
        const icon = button.iconPath instanceof vscode.ThemeIcon ? button.iconPath.id : "";
        if (icon === "refresh") {
          picker.busy = true;
          try {
            await refreshAccountUsage({ force: true, manual: true });
          } finally {
            picker.items = buildItems();
            picker.busy = false;
          }
          return;
        }
        if (icon === "trash") {
          if (await usage.clearHistory()) {
            picker.items = buildItems();
            vscode.window.showInformationMessage("NaN Builders local usage history cleared.");
          } else {
            vscode.window.showErrorMessage("Could not clear NaN Builders local usage history from VS Code storage.");
          }
          return;
        }
        if (icon === "gear") {
          picker.hide();
          await manageProvider(context, provider, refreshAccountUsage);
          return;
        }
        if (icon === "globe") {
          await vscode.env.openExternal(vscode.Uri.parse(NAN_DASHBOARD_URL));
        }
      });
      picker.onDidHide(() => picker.dispose());
      picker.show();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("nanBuilders")) {
        provider.refresh();
        usage.refreshVisibility();
      }
      if (event.affectsConfiguration("nanBuilders.apiBaseUrl")) {
        void refreshAccountUsage({ force: true });
      }
    }),
  );
  diagnostic("activate.complete", { subscriptionCount: context.subscriptions.length });

  // Initial account-wide usage fetch. Skipped in tests: the integration mock has no /v1/usage.
  if (context.extensionMode !== vscode.ExtensionMode.Test) {
    void refreshAccountUsage();
  }

  // Expose only a narrow setup hook to the isolated VS Code integration test.
  return context.extensionMode === vscode.ExtensionMode.Test
    ? {
        setTestApiKey: (key) => provider.setApiKey(key),
        clearTestApiKey: () => provider.clearApiKey(),
        readTestUsageHistory: () => context.globalState.get("nanBuilders.localUsageHistory"),
        clearTestUsageHistory: () => usage.clearHistory(),
      }
    : undefined;
}

async function manageProvider(
  context: vscode.ExtensionContext,
  provider: NanChatModelProvider,
  onKeyChanged?: () => Promise<void>,
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
        await onKeyChanged?.();
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

function accountItems(account: AccountUsageService): vscode.QuickPickItem[] {
  const snapshot = account.snapshot;
  const lastError = account.lastError;
  const errorRow: vscode.QuickPickItem[] = lastError
    ? [
        {
          label: "$(warning) Last refresh failed",
          detail: lastError.retryAfterSeconds !== undefined
            ? `${lastError.message} (retry after ${lastError.retryAfterSeconds}s)`
            : lastError.message,
        },
      ]
    : [];
  if (!snapshot) {
    return [
      {
        label: lastError ? "$(warning) Account usage unavailable" : "$(pulse) Account usage",
        detail: lastError
          ? lastError.message
          : "Not loaded yet. Configure an API key (gear button) or press refresh.",
      },
      ...errorRow.slice(1),
    ];
  }
  const report = snapshot.report;
  const header: vscode.QuickPickItem = {
    label: "$(pulse) Account usage",
    description: `${snapshot.startDate} → ${snapshot.endDate}`,
    detail:
      `Window totals: ${report.totals.totalTokens.toLocaleString()} tokens ` +
      `(${report.totals.promptTokens.toLocaleString()} prompt + ${report.totals.completionTokens.toLocaleString()} completion)` +
      ` · ${report.totals.apiRequests.toLocaleString()} API requests · fetched ${snapshot.fetchedAt}`,
  };
  const allTime: vscode.QuickPickItem = {
    label: "All-time totals",
    description: `${report.allTime.totalTokens.toLocaleString()} tokens`,
    detail: `${report.allTime.apiRequests.toLocaleString()} API requests · cached at ${report.allTime.cachedAt}`,
  };
  const rows = accountModelRows(report).map((row): vscode.QuickPickItem => {
    const usage = `${compactTokens(row.totalTokens)} tokens`;
    const percent = row.percent !== undefined ? ` · ${percentText(row.percent)}% of monthly quota` : "";
    const note = row.note ? ` · ${row.note}` : "";
    return {
      label: `  ${row.model}`,
      description: `${usage}${percent}${note}`,
      detail:
        `${row.promptTokens.toLocaleString()} prompt + ${row.completionTokens.toLocaleString()} completion` +
        ` · ${row.apiRequests.toLocaleString()} API requests this window`,
    };
  });
  const cutoff: vscode.QuickPickItem = {
    label: "Daily API-request counts start",
    description: API_REQUESTS_CUTOFF_DATE,
    detail: "Earlier days in the window report 0 requests.",
  };
  return [header, allTime, ...rows, cutoff, ...errorRow];
}

function percentText(value: number): string {
  return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function deactivate(): void {}
