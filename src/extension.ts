import * as vscode from "vscode";
import { NAN_DASHBOARD_URL, NAN_DOCS_URL, PROVIDER_VENDOR, SECRET_API_KEY, DEFAULT_API_BASE_URL } from "./constants";
import { configureDiagnosticFile, diagnostic } from "./diagnostics";
import { HttpEndpointConsentDeniedError, HttpEndpointGuard } from "./httpEndpointGuard";
import { NanInlineCompletionProvider } from "./inlineCompletionProvider";
import { NanChatModelProvider, ModelDiscoveryError } from "./provider";
import { collectDiagnostics, formatConnectionOk, formatConnectionWarning, selectHostModels } from "./providerDiagnostics";
import { getKnownModel, resolveReasoningEffort } from "./modelCatalog";
import { AccountUsageService, accountModelRows, windowCredits } from "./accountUsage";
import { compactTokens } from "./quotaCatalog";
import { API_REQUESTS_CUTOFF_DATE, CACHED_TOKENS_CUTOFF_DATE, CREDITS_CUTOFF_DATE, type UsageCredits } from "./usageApi";
import { describePackExpiry, formatCredits, formatPercent, usageLinks, type UsageLink } from "./usagePresentation";
import { UsageTracker } from "./usageTracker";

const USAGE_LINK_ICON = "$(link-external)";

function usageLinkLabel(link: UsageLink): string {
  return `${USAGE_LINK_ICON} ${link.label}`;
}

function usageLinkItems(): vscode.QuickPickItem[] {
  return usageLinks().map((link) => ({
    label: usageLinkLabel(link),
    description: link.description,
    detail: link.url,
  }));
}

function buildQuickPickItems(
  account: AccountUsageService,
  usage: UsageTracker,
): vscode.QuickPickItem[] {
  return [
    ...accountItems(account),
    { kind: vscode.QuickPickItemKind.Separator, label: "Billing posture (local session)" },
    ...usage.quotaItems(),
    { kind: vscode.QuickPickItemKind.Separator, label: "Recent local daily history" },
    ...usage.historyItems(),
    { kind: vscode.QuickPickItemKind.Separator, label: "Open" },
    ...usageLinkItems(),
  ];
}

export function activate(context: vscode.ExtensionContext): {
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
} | undefined {
  const diagnosticsEnabled = vscode.workspace
    .getConfiguration("nanBuilders")
    .get<boolean>("diagnostics.enabled", false);
  const diagnosticChannel = diagnosticsEnabled
    ? vscode.window.createOutputChannel("NaN Builders Diagnostics")
    : undefined;
  if (diagnosticChannel) {
    context.subscriptions.push(diagnosticChannel);
  }
  configureDiagnosticFile(context.logUri.fsPath, diagnosticsEnabled, diagnosticChannel);
  let testHttpConsentApproved = false;
  const testHttpConsentPrompts: string[] = [];
  const endpointGuard = new HttpEndpointGuard(async (endpoint) => {
    if (context.extensionMode === vscode.ExtensionMode.Test) {
      testHttpConsentPrompts.push(endpoint);
      return testHttpConsentApproved;
    }

    const choice = await vscode.window.showWarningMessage(
      `NaN Builders will send your API key over unencrypted HTTP to ${endpoint}. Anyone able to observe this network traffic could read the key. Continue only if you trust this endpoint and network.`,
      { modal: true },
      "Send API key over HTTP",
    );
    return choice === "Send API key over HTTP";
  });
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
  }, endpointGuard);
  const usage = new UsageTracker(context.globalState, account);
  diagnostic("activate.usageTracker.created");
  const provider = new NanChatModelProvider(context, usage, endpointGuard);
  let inlineStartupGate: (() => Promise<void>) | undefined;
  let inlineTestSource: vscode.CancellationTokenSource | undefined;
  let inlineRegistrationSelector: vscode.DocumentSelector | undefined;
  const inlineSecrets: vscode.SecretStorage =
    context.extensionMode === vscode.ExtensionMode.Test
      ? {
          keys: () => context.secrets.keys(),
          get: async (key) => {
            await inlineStartupGate?.();
            return context.secrets.get(key);
          },
          store: (key, value) => context.secrets.store(key, value),
          delete: (key) => context.secrets.delete(key),
          onDidChange: (listener) => context.secrets.onDidChange(listener),
        }
      : context.secrets;
  const inlineCompletions = new NanInlineCompletionProvider(inlineSecrets, endpointGuard);
  const registerInlineCompletions = (selector: vscode.DocumentSelector): vscode.Disposable => {
    inlineRegistrationSelector = selector;
    return vscode.languages.registerInlineCompletionItemProvider(selector, inlineCompletions);
  };
  let inlineRegistration: vscode.Disposable | undefined;
  const syncInlineCompletions = (): void => {
    const model = vscode.workspace.getConfiguration("nanBuilders").get<string>("completionModel", "").trim();
    if (model && !inlineRegistration) {
      inlineRegistration = registerInlineCompletions([{ scheme: "file" }]);
    } else if (!model && inlineRegistration) {
      inlineRegistration.dispose();
      inlineRegistration = undefined;
      inlineRegistrationSelector = undefined;
    }
  };
  const inlineRegistrationCleanup: vscode.Disposable = {
    dispose: () => {
      inlineRegistration?.dispose();
      inlineRegistration = undefined;
      inlineRegistrationSelector = undefined;
    },
  };
  syncInlineCompletions();
  diagnostic("activate.provider.created");

  const refreshAccountUsage = async (options: { force?: boolean; manual?: boolean } = {}): Promise<void> => {
    try {
      await account.refresh({ force: options.force ?? false });
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      // Background failures stay in diagnostics + tooltip; only manual refreshes toast.
      diagnostic("refreshAccountUsage.error", { errorName: error instanceof Error ? error.name : typeof error });
      if (options.manual) {
        vscode.window.showErrorMessage(errorMessage(error));
      }
    } finally {
      usage.accountUpdated();
    }
  };

  // "Show Diagnostics" falls back to this channel when the Markdown document cannot be opened.
  let reportChannel: vscode.OutputChannel | undefined;
  const reportOutputChannel = (): vscode.OutputChannel => {
    if (diagnosticChannel) {
      return diagnosticChannel;
    }
    if (!reportChannel) {
      reportChannel = vscode.window.createOutputChannel("NaN Builders Diagnostics", "markdown");
      context.subscriptions.push(reportChannel);
    }
    return reportChannel;
  };

  context.subscriptions.push(
    usage,
    provider,
    inlineRegistrationCleanup,
    vscode.lm.registerLanguageModelChatProvider(PROVIDER_VENDOR, provider),
    vscode.commands.registerCommand("nanBuilders.manage", () => manageProvider(context, provider, refreshAccountUsage)),
    vscode.commands.registerCommand("nanBuilders.refreshModels", async () => {
      provider.refresh();
      vscode.window.showInformationMessage("NaN Builders model list refreshed.");
    }),
    vscode.commands.registerCommand("nanBuilders.testConnection", () => testConnection(context, provider)),
    vscode.commands.registerCommand("nanBuilders.showDiagnostics", () =>
      showDiagnostics(context, provider, reportOutputChannel()),
    ),
    vscode.commands.registerCommand("nanBuilders.setReasoningEffort", () => setModelReasoningEffort(provider)),
    vscode.commands.registerCommand("nanBuilders.showUsage", () => {
      const picker = vscode.window.createQuickPick<vscode.QuickPickItem>();
      picker.title = "NaN Builders usage";
      picker.placeholder = "Account-wide credit usage, billing posture, and this extension's local history.";
      picker.matchOnDescription = true;
      picker.matchOnDetail = true;
      picker.items = buildQuickPickItems(account, usage);
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
            picker.items = buildQuickPickItems(account, usage);
            picker.busy = false;
          }
          return;
        }
        if (icon === "trash") {
          if (await usage.clearHistory()) {
            picker.items = buildQuickPickItems(account, usage);
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
      picker.onDidAccept(async () => {
        const selected = picker.selectedItems[0]?.label;
        const link = usageLinks().find((entry) => usageLinkLabel(entry) === selected);
        if (!link) {
          return;
        }
        picker.hide();
        await vscode.env.openExternal(vscode.Uri.parse(link.url));
      });
      picker.onDidHide(() => picker.dispose());
      picker.show();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("nanBuilders")) {
        provider.refresh();
        usage.refreshVisibility();
      }
      if (event.affectsConfiguration("nanBuilders.completionModel")) {
        syncInlineCompletions();
      }
      if (event.affectsConfiguration("nanBuilders.apiBaseUrl")) {
        endpointGuard.resetDenials();
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
        validateModelsTest: () => provider.validateConfiguredKey(),
        refreshUsageTest: () => refreshAccountUsage({ force: true }),
        setHttpConsentTest: (approved) => {
          testHttpConsentApproved = approved;
          endpointGuard.resetDenials();
        },
        readHttpConsentPromptsTest: () => [...testHttpConsentPrompts],
        readTestUsageHistory: () => context.globalState.get("nanBuilders.localUsageHistory"),
        clearTestUsageHistory: () => usage.clearHistory(),
        provideInlineTest: async (document, position, options) => {
          const source = new vscode.CancellationTokenSource();
          inlineTestSource = source;
          if (options?.cancelDuringStartup) {
            // Cancel exactly at the secrets.get boundary: after the provider's
            // entry check, before any request can be built or sent.
            inlineStartupGate = async () => source.cancel();
          }
          try {
            return await inlineCompletions.provideInlineCompletionItems(
              document,
              position,
              { triggerKind: vscode.InlineCompletionTriggerKind.Invoke, selectedCompletionInfo: undefined },
              source.token,
            );
          } finally {
            inlineStartupGate = undefined;
            inlineTestSource = undefined;
            source.dispose();
          }
        },
        cancelInlineTest: () => inlineTestSource?.cancel(),
        getInlineRegistrationTest: () => inlineRegistrationSelector,
      }
    : undefined;
}

/**
 * Per-model reasoning effort selector: picks a model that documents effort
 * levels, then one of that model's real levels (or resets it to auto).
 * Overrides land in `nanBuilders.reasoningEffortByModel`.
 */
async function setModelReasoningEffort(provider: NanChatModelProvider): Promise<void> {
  const cancellation = new vscode.CancellationTokenSource();
  let models: vscode.LanguageModelChatInformation[];
  try {
    models = await provider.provideLanguageModelChatInformation({ silent: false }, cancellation.token);
  } finally {
    cancellation.dispose();
  }
  const selectable = models
    .map((model) => ({ model, ladder: getKnownModel(model.id)?.reasoningEffortValues ?? [] }))
    .filter((entry) => entry.ladder.length > 0);
  if (selectable.length === 0) {
    vscode.window.showInformationMessage("No NaN Builders models with selectable reasoning effort are available (configure an API key first).");
    return;
  }
  const modelPick = await vscode.window.showQuickPick(
    selectable.map(({ model, ladder }) => ({
      id: model.id,
      label: model.name,
      description: ladder.join(" < "),
    })),
    { title: "NaN Builders: Set Model Reasoning Effort", placeHolder: "Choose a model" },
  );
  if (!modelPick) {
    return;
  }
  const selected = selectable.find((candidate) => candidate.model.id === modelPick.id)!;
  const entry = { id: selected.model.id, ladder: selected.ladder };
  const configuration = vscode.workspace.getConfiguration("nanBuilders");
  const overrides = configuration.get<Record<string, unknown>>("reasoningEffortByModel", {});
  const perModel = typeof overrides?.[entry.id] === "string" ? (overrides[entry.id] as string) : undefined;
  const current = resolveReasoningEffort({
    perModelOverride: perModel,
    globalDefault: configuration.get<string>("defaultReasoningEffort", "auto"),
    ladder: entry.ladder,
  });
  const levelPick = await vscode.window.showQuickPick(
    [
      ...entry.ladder.map((level) => ({
        label: level,
        description: level === current ? "$(checkmark) current" : undefined,
        detail: level === current ? (perModel ? "per-model override" : "effective default") : undefined,
      })),
      { label: "Reset to auto", description: perModel ? "clears the per-model override" : "no override set", detail: "Use the global default / model default." },
    ],
    { title: `${modelPick.label}: reasoning effort`, placeHolder: "Choose a level (values outside the model ladder are remapped to the closest one)" },
  );
  if (!levelPick) {
    return;
  }
  const next: Record<string, unknown> = { ...overrides };
  if (levelPick.label === "Reset to auto") {
    delete next[entry.id];
  } else {
    next[entry.id] = levelPick.label;
  }
  await configuration.update("reasoningEffortByModel", next, vscode.ConfigurationTarget.Global);
  provider.refresh();
  vscode.window.showInformationMessage(
    levelPick.label === "Reset to auto"
      ? `NaN Builders: ${modelPick.label} reasoning effort reset to auto.`
      : `NaN Builders: ${modelPick.label} reasoning effort set to ${levelPick.label}.`,
  );
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
        if (error instanceof HttpEndpointConsentDeniedError) {
          vscode.window.showInformationMessage(
            "The API key was saved, but it was not validated because HTTP endpoint access was declined.",
          );
        } else if (!isAbortError(error)) {
          vscode.window.showErrorMessage(errorMessage(error));
        }
      }
      return;
    }
    case "validate": {
      try {
        const count = await provider.validateConfiguredKey();
        provider.refresh();
        vscode.window.showInformationMessage(`NaN Builders API key is valid. ${count} model IDs are currently available to this API key.`);
      } catch (error) {
        if (error instanceof HttpEndpointConsentDeniedError) {
          vscode.window.showInformationMessage("Validation was canceled because HTTP endpoint access was declined.");
        } else if (!isAbortError(error)) {
          vscode.window.showErrorMessage(errorMessage(error));
        }
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

/**
 * "Test Connection": silent, read-only model discovery for the stored key.
 * A missing key, no reachable models, or a gateway error each produce an
 * actionable warning; gateway text is sanitized before it is displayed.
 */
async function testConnection(context: vscode.ExtensionContext, provider: NanChatModelProvider): Promise<void> {
  const apiKey = await context.secrets.get(SECRET_API_KEY);
  if (!apiKey) {
    vscode.window.showWarningMessage(
      "No NaN Builders API key is configured. Run 'NaN Builders: Manage Provider' to add one, then test the connection again.",
    );
    return;
  }

  try {
    const modelIds = await provider.probeConfiguredKey();
    diagnostic("testConnection.complete", { modelCount: modelIds.length });
    if (modelIds.length === 0) {
      vscode.window.showWarningMessage(formatConnectionWarning(provider.getBaseUrl(), provider.discoveryError()));
      return;
    }
    vscode.window.showInformationMessage(`NaN Builders: ${formatConnectionOk(modelIds)}`);
  } catch (error) {
    if (error instanceof HttpEndpointConsentDeniedError) {
      vscode.window.showWarningMessage(
        "NaN Builders could not test the connection because access to the HTTP endpoint was declined.",
      );
      return;
    }
    if (isAbortError(error)) {
      return;
    }
    diagnostic("testConnection.error", { errorName: error instanceof Error ? error.name : typeof error });
    vscode.window.showWarningMessage(
      formatConnectionWarning(
        provider.getBaseUrl(),
        error instanceof ModelDiscoveryError
          ? error
          : error instanceof Error
            ? error.message
            : String(error),
      ),
    );
  }
}

/**
 * "Show Diagnostics": a pasteable Markdown dump of versions, endpoint, the
 * models this VS Code host actually exposes, the configured key count, and the
 * locally tracked models. Never includes key material.
 */
async function showDiagnostics(
  context: vscode.ExtensionContext,
  provider: NanChatModelProvider,
  channel: vscode.OutputChannel,
): Promise<void> {
  let hostModels: Awaited<ReturnType<typeof selectHostModels>>;
  try {
    // Selecting host models can run provider discovery, which updates the
    // native endpoint, stored key, cache, and discovery error. Select first so
    // the snapshot below reflects the state the host models were produced from.
    hostModels = await selectHostModels(vscode.lm, PROVIDER_VENDOR);
  } catch (error) {
    vscode.window.showErrorMessage(`NaN Builders diagnostics failed to read the host model list: ${errorMessage(error)}`);
    return;
  }

  const secretKeys = await context.secrets.keys();
  let markdown: string;
  try {
    markdown = collectDiagnostics({
      extensionVersion: String(context.extension.packageJSON.version ?? "unknown"),
      vscodeVersion: vscode.version,
      baseUrl: provider.getBaseUrl(),
      configuration: vscode.workspace.getConfiguration("nanBuilders"),
      hostModels,
      secretKeys,
      trackedModels: provider.trackedModelIds(),
      lastDiscoveryError: provider.discoveryError(),
    });
  } catch (error) {
    vscode.window.showErrorMessage(`NaN Builders diagnostics failed to build the report: ${errorMessage(error)}`);
    return;
  }

  try {
    const document = await vscode.workspace.openTextDocument({ language: "markdown", content: markdown });
    await vscode.window.showTextDocument(document, { preview: false });
  } catch {
    channel.appendLine(markdown);
    channel.show(true);
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
      `(${report.totals.promptTokens.toLocaleString()} prompt + ${report.totals.completionTokens.toLocaleString()} completion` +
      `${report.totals.cachedTokens ? `, ${report.totals.cachedTokens.toLocaleString()} cached` : ""})` +
      ` · ${report.totals.apiRequests.toLocaleString()} API requests · fetched ${snapshot.fetchedAt}`,
  };
  const allTime: vscode.QuickPickItem = {
    label: "All-time totals",
    description: `${report.allTime.totalTokens.toLocaleString()} tokens`,
    detail: `${report.allTime.apiRequests.toLocaleString()} API requests · cached at ${report.allTime.cachedAt}`,
  };
  const rows = accountModelRows(report).map((row): vscode.QuickPickItem => {
    const usage = `${compactTokens(row.totalTokens)} tokens`;
    const credits = row.credits !== undefined ? ` · ${formatCredits(row.credits)} credits` : "";
    const percent = row.percent !== undefined ? ` · ${formatPercent(row.percent)}% of plan credits` : "";
    const note = row.note ? ` · ${row.note}` : "";
    return {
      label: `  ${row.model}`,
      description: `${usage}${credits}${percent}${note}`,
      detail:
        `${row.promptTokens.toLocaleString()} prompt + ${row.completionTokens.toLocaleString()} completion` +
        `${row.cachedTokens ? ` (${row.cachedTokens.toLocaleString()} cached)` : ""}` +
        ` · ${row.apiRequests.toLocaleString()} API requests this window`,
    };
  });
  const creditRows = creditsItems(report.credits);
  const windowCredit = windowCredits(report);
  const windowRow: vscode.QuickPickItem[] =
    windowCredit === undefined
      ? []
      : [
          {
            label: "$(credit-card) Window credits (calendar month)",
            description: `${formatCredits(windowCredit)} credits`,
            detail:
              `Approximate sum of the per-model rows in ${snapshot.startDate} to ${snapshot.endDate}; ` +
              `the billing-period used total can differ by tenths.`,
          },
        ];
  const cutoff: vscode.QuickPickItem = {
    label: "Daily API-request counts start",
    description: API_REQUESTS_CUTOFF_DATE,
    detail: "Earlier days in the window report 0 requests.",
  };
  const creditsCutoff: vscode.QuickPickItem = {
    label: "Credits billing starts",
    description: CREDITS_CUTOFF_DATE,
    detail: `Per-model credits are reported from this date; cached input tokens from ${CACHED_TOKENS_CUTOFF_DATE}.`,
  };
  return [header, allTime, ...creditRows, ...windowRow, ...rows, cutoff, creditsCutoff, ...errorRow];
}

/** Plan-credit rows for the account QuickPick; empty on accounts not billed in credits. */
function creditsItems(credits: UsageCredits | undefined): vscode.QuickPickItem[] {
  if (!credits || (credits.allowance === undefined && credits.used === undefined)) {
    return [];
  }
  const summary = [
    credits.allowance === undefined ? undefined : `${formatCredits(credits.allowance)} allowance`,
    credits.packCredits ? `${formatCredits(credits.packCredits)} pack` : undefined,
  ].filter((part): part is string => part !== undefined);
  const detail = [
    credits.used === undefined ? undefined : `${formatCredits(credits.used)} used`,
    credits.remaining === undefined ? undefined : `${formatCredits(credits.remaining)} remaining`,
    credits.periodStart && credits.periodEnd
      ? `${credits.periodStart} → ${credits.periodEnd}`
      : credits.periodEnd
        ? `renews ${credits.periodEnd}`
        : undefined,
  ].filter((part): part is string => part !== undefined);
  const items: vscode.QuickPickItem[] = [
    {
      label: credits.frozen ? "$(warning) Plan credits (frozen)" : "$(credit-card) Plan credits",
      description: summary.join(" + "),
      detail: credits.frozen
        ? `${detail.join(" · ")} · credit-billed requests are refused until the subscription is active again`
        : detail.join(" · "),
    },
  ];
  if (credits.packCredits && credits.packExpiresAt) {
    items.push({
      label: "Credit pack expiry",
      description: describePackExpiry(credits.packExpiresAt),
      detail: "Pack credits are consumed after the plan allowance runs out.",
    });
  }
  return items;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function deactivate(): void {}
