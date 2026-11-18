import * as vscode from "vscode";
import { NAN_DASHBOARD_URL, NAN_DOCS_URL, PROVIDER_VENDOR, SECRET_API_KEY, DEFAULT_API_BASE_URL } from "./constants";
import { configureDiagnosticFile, diagnostic } from "./diagnostics";
import { HttpEndpointConsentDeniedError, HttpEndpointGuard } from "./httpEndpointGuard";
import { NanInlineCompletionProvider } from "./inlineCompletionProvider";
import { NanChatModelProvider, ModelDiscoveryError } from "./provider";
import { collectDiagnostics, formatConnectionOk, formatConnectionWarning, selectHostModels } from "./providerDiagnostics";
import {
  AUTO_EFFORT,
  MAX_PROFILE_ID_LENGTH,
  assignModelToProfile,
  assignedProfileForModel,
  effortOverride,
  isValidProfileId,
  nextActiveProfile,
  normalizeProfileIds,
  parseProfileModelAssignment,
  profileSecretName,
  readConfiguredCredential,
  removeModelAssignment,
  removeProfileAssignments,
  renameProfileAssignments,
  resolveActiveProfile,
  resolveModelRoute,
  type ProfileSettings,
} from "./profiles";
import {
  DEFAULT_MAX_PARALLEL_REQUESTS,
  SlotQueueRegistry,
  resolveMaxParallelRequests,
} from "./openai/slotQueue";
import { getKnownModel, resolveReasoningEffort } from "./modelCatalog";
import { AccountUsageService, accountModelRows, windowCredits } from "./accountUsage";
import { compactTokens } from "./quotaCatalog";
import { API_REQUESTS_CUTOFF_DATE, CACHED_TOKENS_CUTOFF_DATE, CREDITS_CUTOFF_DATE, type UsageCredits } from "./usageApi";
import {
  describePackExpiry,
  formatCredits,
  formatPercent,
  LowCreditWatcher,
  usageLinks,
  type RemainingCredits,
  type UsageLink,
} from "./usagePresentation";
import { UsageTracker } from "./usageTracker";
import { FAILOVER_SETTING, FAILOVER_WARNING, failoverWarningPending } from "./failover";

const USAGE_LINK_ICON = "$(link-external)";
/** Global-state key recording that the own-accounts failover warning was shown. */
const FAILOVER_WARNING_ACK = "nanBuilders.failoverWarningAcknowledged";

/** Profile settings as the extension reads them; ids only, never keys. */
function profileSettings(): ProfileSettings {
  const configuration = vscode.workspace.getConfiguration("nanBuilders");
  return {
    profiles: normalizeProfileIds(configuration.get<unknown>("profiles", [])),
    activeProfile: configuration.get<string>("activeProfile", ""),
  };
}

function effortOverrides(): Record<string, unknown> {
  return vscode.workspace.getConfiguration("nanBuilders").get<Record<string, unknown>>("reasoningEffortByModel", {}) ?? {};
}

/**
 * Writes `profiles` and `activeProfile` together, profile list first: a request
 * resolving between the two writes then sees the new list with a stale active
 * id, which falls back to the first profile instead of a removed one.
 */
async function writeProfileSettings(profiles: readonly string[], activeProfile: string): Promise<void> {
  const configuration = vscode.workspace.getConfiguration("nanBuilders");
  await configuration.update("profiles", profiles, vscode.ConfigurationTarget.Global);
  await configuration.update("activeProfile", activeProfile, vscode.ConfigurationTarget.Global);
}

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
    // Account usage belongs to the credential the models use by default: the
    // active profile key when profiles are configured, else the shared key.
    const credential = await readConfiguredCredential(
      profileSettings(),
      (name) => context.secrets.get(name),
      SECRET_API_KEY,
    );
    if (!credential.apiKey) {
      return undefined;
    }
    return {
      baseUrl: vscode.workspace
        .getConfiguration("nanBuilders")
        .get<string>("apiBaseUrl", DEFAULT_API_BASE_URL)
        .replace(/\/+$/, ""),
      apiKey: credential.apiKey,
    };
  }, endpointGuard);
  const usage = new UsageTracker(context.globalState, account);
  diagnostic("activate.usageTracker.created");
  // One set of slots per API key, shared by chat and inline completions so the
  // gateway's per-key concurrency limit holds across both paths.
  const slotQueues = new SlotQueueRegistry(() =>
    resolveMaxParallelRequests(
      vscode.workspace
        .getConfiguration("nanBuilders")
        .get<number>("maxParallelRequests", DEFAULT_MAX_PARALLEL_REQUESTS),
    ),
  );
  const provider = new NanChatModelProvider(context, usage, endpointGuard, slotQueues);
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
  const inlineCompletions = new NanInlineCompletionProvider(
    inlineSecrets,
    endpointGuard,
    slotQueues,
    usage,
  );
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

  // At most one low-credit warning per threshold crossing, per extension session.
  const lowCreditWatcher = new LowCreditWatcher();
  const notifyLowCredits = (): void => {
    const threshold = vscode.workspace
      .getConfiguration("nanBuilders")
      .get<number>("lowCreditWarningPercent", 10);
    const decision = lowCreditWatcher.update(account.snapshot?.report.credits, threshold);
    diagnostic("refreshAccountUsage.lowCredits", {
      warn: decision.warn,
      low: decision.low,
      percent: decision.remaining?.percent ?? "unavailable",
    });
    if (decision.warn && decision.remaining) {
      void warnLowCredits(decision.remaining);
    }
  };

  const refreshAccountUsage = async (options: { force?: boolean; manual?: boolean } = {}): Promise<void> => {
    try {
      await account.refresh({ force: options.force ?? false });
      notifyLowCredits();
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

  // Recorded once so the vendor id in use is visible in diagnostics (#118).
  diagnostic("activate.provider.vendor", { vendor: PROVIDER_VENDOR });
  // Opt-in failover (#144) only ever uses accounts the user owns and pays for:
  // NaN issues one personal, non-transferable key per member, so several keys
  // are not a pooled allowance. The reminder appears once, on first enable.
  const warnFailoverOnce = (): void => {
    const acknowledged = context.globalState.get<boolean>(FAILOVER_WARNING_ACK, false) === true;
    if (!failoverWarningPending(provider.failoverEnabled(), acknowledged)) {
      return;
    }
    // Recorded before showing it so a reload can never repeat the warning.
    void context.globalState.update(FAILOVER_WARNING_ACK, true);
    diagnostic("activate.failover.enabled", { setting: FAILOVER_SETTING });
    void vscode.window.showWarningMessage(FAILOVER_WARNING);
  };
  warnFailoverOnce();
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
    vscode.commands.registerCommand("nanBuilders.testConnection", () => testConnection(provider)),
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
      if (event.affectsConfiguration("nanBuilders.maxParallelRequests")) {
        slotQueues.refresh();
      }
      if (event.affectsConfiguration("nanBuilders.failoverOnThrottle")) {
        provider.clearCooldowns();
        warnFailoverOnce();
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
  // The write targets the entry that actually governs the request: the
  // `profile::model` assignment when the model is routed to a profile, else the
  // plain model id.
  const route = resolveModelRoute(profileSettings(), overrides, entry.id);
  const overrideKey =
    route.source === "assignment" && route.profileId ? `${route.profileId}::${entry.id}` : entry.id;
  const routedTo = route.source === "assignment" ? route.profileId : undefined;
  const perModel = effortOverride(overrides, entry.id, route.profileId);
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
    {
      title: `${modelPick.label}: reasoning effort${routedTo ? ` (profile "${routedTo}")` : ""}`,
      placeHolder: "Choose a level (values outside the model ladder are remapped to the closest one)",
    },
  );
  if (!levelPick) {
    return;
  }
  const next: Record<string, unknown> = { ...overrides };
  if (levelPick.label === "Reset to auto") {
    // A routed model keeps its `profile::model` entry (routing is not an
    // effort), so the entry is reset to `auto` instead of being removed.
    if (routedTo) {
      next[overrideKey] = AUTO_EFFORT;
    } else {
      delete next[overrideKey];
    }
  } else {
    next[overrideKey] = levelPick.label;
  }
  await configuration.update("reasoningEffortByModel", next, vscode.ConfigurationTarget.Global);
  provider.refresh();
  const message =
    levelPick.label === "Reset to auto"
      ? `NaN Builders: ${modelPick.label} reasoning effort reset to auto.`
      : `NaN Builders: ${modelPick.label} reasoning effort set to ${levelPick.label}.`;
  vscode.window.showInformationMessage(
    routedTo ? `${message} The model still uses profile "${routedTo}".` : message,
  );
}

type ProviderAction =
  | "set"
  | "validate"
  | "clear"
  | "profiles"
  | "assign"
  | "unassign"
  | "dashboard"
  | "docs";

/** The credential Manage Provider acts on: the active profile, else the shared key. */
function credentialScope(activeProfile: string | undefined): string {
  return activeProfile ? `profile "${activeProfile}"` : "shared key";
}

async function manageProvider(
  context: vscode.ExtensionContext,
  provider: NanChatModelProvider,
  onKeyChanged?: () => Promise<void>,
): Promise<void> {
  const settings = profileSettings();
  const activeProfile = resolveActiveProfile(settings);
  const credential = await readConfiguredCredential(settings, (name) => context.secrets.get(name), SECRET_API_KEY);
  const existing = credential.apiKey;
  const scope = credentialScope(activeProfile);
  const assignments = Object.keys(effortOverrides()).filter((key) => parseProfileModelAssignment(key) !== undefined);

  const items: Array<vscode.QuickPickItem & { action?: ProviderAction }> = [
    {
      label: "$(key) Set or replace API key",
      description: existing ? `A key is configured for the ${scope}` : `No key configured for the ${scope}`,
      action: "set",
    },
    {
      label: "$(check) Validate API key and refresh models",
      description: existing ? `Check the ${scope} against /v1/models` : "Configure a key first",
      action: "validate",
    },
  ];

  if (existing) {
    items.push({
      label: "$(trash) Clear API key",
      description: `Remove the ${scope} from VS Code SecretStorage`,
      action: "clear",
    });
  }

  items.push(
    { kind: vscode.QuickPickItemKind.Separator, label: "Profiles" },
    {
      label: "$(account) Manage profiles",
      description: settings.profiles.length
        ? `${settings.profiles.length} configured · active: ${activeProfile ?? "none"}`
        : "No profiles configured; models use the shared key",
      action: "profiles",
    },
    {
      label: "$(symbol-namespace) Assign a model to a profile",
      description: settings.profiles.length
        ? "Route one model with a profile::model entry"
        : "Add a profile first",
      action: "assign",
    },
    ...(assignments.length > 0
      ? [
          {
            label: "$(close) Remove a model assignment",
            description: `${assignments.length} profile::model assignment(s) configured`,
            action: "unassign" as ProviderAction,
          },
        ]
      : []),
    { kind: vscode.QuickPickItemKind.Separator, label: "Links" },
    {
      label: "$(link-external) Open NaN Builders dashboard",
      action: "dashboard",
    },
    {
      label: "$(book) Open NaN Builders documentation",
      action: "docs",
    },
  );

  const choice = await vscode.window.showQuickPick(items, {
    title: "NaN Builders",
    placeHolder: "Manage the VS Code language model provider",
  });
  if (!choice?.action) {
    return;
  }

  switch (choice.action) {
    case "set": {
      const value = await vscode.window.showInputBox({
        title: activeProfile ? `NaN Builders API Key for profile "${activeProfile}"` : "NaN Builders API Key",
        prompt: activeProfile
          ? `Paste the API key for profile "${activeProfile}". It is stored in VS Code SecretStorage under ${profileSecretName(activeProfile)}.`
          : "Paste your API key. It is stored in VS Code SecretStorage.",
        password: true,
        ignoreFocusOut: true,
        placeHolder: "sk-...",
      });
      if (!value?.trim()) {
        return;
      }
      if (activeProfile) {
        await provider.setProfileKey(activeProfile, value.trim());
      } else {
        await provider.setApiKey(value.trim());
      }
      try {
        const count = await provider.validateConfiguredKey();
        vscode.window.showInformationMessage(
          `NaN Builders API key saved for the ${scope}. ${count} model IDs are currently available to this API key.`,
        );
        await onKeyChanged?.();
      } catch (error) {
        if (error instanceof HttpEndpointConsentDeniedError) {
          vscode.window.showInformationMessage(
            `The API key was saved for the ${scope}, but it was not validated because HTTP endpoint access was declined.`,
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
        vscode.window.showInformationMessage(
          `NaN Builders API key is valid for the ${scope}. ${count} model IDs are currently available to this API key.`,
        );
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
      if (activeProfile) {
        await provider.clearProfileKey(activeProfile);
      } else {
        await provider.clearApiKey();
      }
      vscode.window.showInformationMessage(
        `NaN Builders API key removed from VS Code SecretStorage (${scope}).`,
      );
      return;
    case "profiles":
      await manageProfiles(context, provider, onKeyChanged);
      return;
    case "assign":
      await assignModelProfile(provider);
      return;
    case "unassign":
      await clearModelAssignment(provider);
      return;
    case "dashboard":
      await vscode.env.openExternal(vscode.Uri.parse(NAN_DASHBOARD_URL));
      return;
    case "docs":
      await vscode.env.openExternal(vscode.Uri.parse(NAN_DOCS_URL));
      return;
  }
}

/** Models worth offering for an assignment, live discovery first. */
async function assignableModelIds(provider: NanChatModelProvider): Promise<string[]> {
  const cancellation = new vscode.CancellationTokenSource();
  try {
    const models = await provider.provideLanguageModelChatInformation({ silent: true }, cancellation.token);
    const ids = models.map((model) => model.id);
    return ids.length > 0 ? ids : provider.trackedModelIds();
  } finally {
    cancellation.dispose();
  }
}

async function pickAssignmentModel(
  provider: NanChatModelProvider,
  title: string,
): Promise<{ id: string; ladder: readonly string[] } | undefined> {
  const ids = await assignableModelIds(provider);
  if (ids.length === 0) {
    vscode.window.showInformationMessage("No NaN Builders models are available to assign yet.");
    return undefined;
  }
  const overrides = effortOverrides();
  const profiles = profileSettings().profiles;
  const picked = await vscode.window.showQuickPick(
    ids.map((id) => {
      const assigned = assignedProfileForModel(overrides, id, profiles);
      return {
        id,
        label: id,
        description: assigned ? `profile "${assigned}"` : undefined,
        detail: assigned ? "Already assigned; picking it keeps the model on one profile." : undefined,
      };
    }),
    { title, placeHolder: "Choose a model" },
  );
  if (!picked) {
    return undefined;
  }
  return { id: picked.id, ladder: getKnownModel(picked.id)?.reasoningEffortValues ?? [] };
}

/**
 * `profile::model` assignment: the model's requests then use that profile's
 * key. The entry lives in `nanBuilders.reasoningEffortByModel`, whose value is
 * the reasoning effort for that model under that profile (`auto` = routing only).
 */
async function assignModelProfile(provider: NanChatModelProvider): Promise<void> {
  const settings = profileSettings();
  if (settings.profiles.length === 0) {
    vscode.window.showInformationMessage(
      "Add a profile first: NaN Builders: Manage Provider → Profiles → Add profile.",
    );
    return;
  }
  const activeProfile = resolveActiveProfile(settings);
  const profilePick = await vscode.window.showQuickPick(
    settings.profiles.map((profileId) => ({
      label: profileId,
      description: profileId === activeProfile ? "active profile" : undefined,
    })),
    { title: "NaN Builders: profile serving one model", placeHolder: "Choose the profile whose API key the model uses" },
  );
  if (!profilePick) {
    return;
  }
  const model = await pickAssignmentModel(provider, `Model served by profile "${profilePick.label}"`);
  if (!model) {
    return;
  }
  const effortPick = await vscode.window.showQuickPick(
    [
      {
        label: AUTO_EFFORT,
        description: "routing only",
        detail: "Keep the model's normal reasoning effort resolution.",
      },
      ...model.ladder.map((level) => ({
        label: level,
        description: "effort for this profile",
        detail: `${model.id} on profile "${profilePick.label}" runs at ${level}.`,
      })),
    ],
    {
      title: `${model.id} on profile "${profilePick.label}"`,
      placeHolder: "Reasoning effort stored with the assignment",
    },
  );
  if (!effortPick) {
    return;
  }
  const next = assignModelToProfile(effortOverrides(), profilePick.label, model.id, effortPick.label);
  await vscode.workspace
    .getConfiguration("nanBuilders")
    .update("reasoningEffortByModel", next, vscode.ConfigurationTarget.Global);
  provider.refresh();
  vscode.window.showInformationMessage(
    `NaN Builders: ${model.id} now uses profile "${profilePick.label}".`,
  );
}

/** Removes one `profile::model` entry, falling the model back to the active profile. */
async function clearModelAssignment(provider: NanChatModelProvider): Promise<void> {
  const overrides = effortOverrides();
  const entries = Object.keys(overrides)
    .map((key) => parseProfileModelAssignment(key))
    .filter((assignment): assignment is { profileId: string; modelId: string } => assignment !== undefined);
  if (entries.length === 0) {
    vscode.window.showInformationMessage("No NaN Builders model assignments are configured.");
    return;
  }
  const picked = await vscode.window.showQuickPick(
    entries.map((assignment) => ({
      label: assignment.modelId,
      description: `profile "${assignment.profileId}"`,
      modelId: assignment.modelId,
      profileId: assignment.profileId,
    })),
    { title: "NaN Builders: remove a model assignment", placeHolder: "The model falls back to the active profile" },
  );
  if (!picked) {
    return;
  }
  await vscode.workspace
    .getConfiguration("nanBuilders")
    .update("reasoningEffortByModel", removeModelAssignment(overrides, picked.modelId), vscode.ConfigurationTarget.Global);
  provider.refresh();
  vscode.window.showInformationMessage(
    `NaN Builders: ${picked.modelId} is no longer assigned to profile "${picked.profileId}".`,
  );
}

/** Per-profile actions: activate, key, rename, delete. */
async function manageProfiles(
  context: vscode.ExtensionContext,
  provider: NanChatModelProvider,
  onKeyChanged?: () => Promise<void>,
): Promise<void> {
  const settings = profileSettings();
  const activeProfile = resolveActiveProfile(settings);
  const secretKeys = await context.secrets.keys();
  const items: Array<vscode.QuickPickItem & { action?: "add" | "open"; profileId?: string }> = settings.profiles.map(
    (profileId) => ({
      label: `${profileId === activeProfile ? "$(check)" : "$(account)"} ${profileId}`,
      description: [
        profileId === activeProfile ? "active" : undefined,
        secretKeys.includes(profileSecretName(profileId)) ? "key configured" : "no key",
      ]
        .filter((part): part is string => part !== undefined)
        .join(" · "),
      action: "open",
      profileId,
    }),
  );
  if (items.length > 0) {
    items.push({ kind: vscode.QuickPickItemKind.Separator, label: "" });
  }
  items.push({ label: "$(add) Add profile", action: "add" });

  const choice = await vscode.window.showQuickPick(items, {
    title: "NaN Builders: profiles",
    placeHolder: "Select a profile to change it, or add one",
  });
  if (!choice?.action) {
    return;
  }
  if (choice.action === "add") {
    await addProfile(provider, onKeyChanged);
    return;
  }
  if (choice.profileId) {
    await manageOneProfile(context, provider, choice.profileId, onKeyChanged);
  }
}

async function addProfile(
  provider: NanChatModelProvider,
  onKeyChanged?: () => Promise<void>,
): Promise<void> {
  const settings = profileSettings();
  const enteredId = await vscode.window.showInputBox({
    title: "NaN Builders: add profile",
    prompt:
      `Profile id (letters, digits, ".", "_" or "-"; up to ${MAX_PROFILE_ID_LENGTH} characters). ` +
      "Settings store the id only; the key goes to VS Code SecretStorage.",
    placeHolder: "work",
    ignoreFocusOut: true,
    validateInput: (value) => {
      const trimmed = value.trim();
      if (!trimmed) {
        return "Enter a profile id.";
      }
      if (!isValidProfileId(trimmed)) {
        return `Use up to ${MAX_PROFILE_ID_LENGTH} characters: letters, digits, ".", "_" or "-", starting with a letter or digit.`;
      }
      if (settings.profiles.includes(trimmed)) {
        return `Profile "${trimmed}" already exists.`;
      }
      return undefined;
    },
  });
  const profileId = enteredId?.trim();
  if (!profileId) {
    return;
  }
  const key = await vscode.window.showInputBox({
    title: `NaN Builders: API key for profile "${profileId}"`,
    prompt: "Paste the API key. It is stored in VS Code SecretStorage and never written to settings.",
    password: true,
    ignoreFocusOut: true,
    placeHolder: "sk-...",
  });
  const profiles = [...settings.profiles, profileId];
  await writeProfileSettings(profiles, nextActiveProfile(profiles, settings.activeProfile));
  if (key?.trim()) {
    await provider.setProfileKey(profileId, key.trim());
  }
  provider.refresh();
  await onKeyChanged?.();
  vscode.window.showInformationMessage(
    key?.trim()
      ? `NaN Builders profile "${profileId}" added with its API key.`
      : `NaN Builders profile "${profileId}" added without an API key. Requests that resolve to it fail and name the profile until you set one.`,
  );
}

async function manageOneProfile(
  context: vscode.ExtensionContext,
  provider: NanChatModelProvider,
  profileId: string,
  onKeyChanged?: () => Promise<void>,
): Promise<void> {
  const settings = profileSettings();
  const activeProfile = resolveActiveProfile(settings);
  const hasKey = (await context.secrets.keys()).includes(profileSecretName(profileId));
  type ProfileAction = "activate" | "setKey" | "clearKey" | "rename" | "delete";
  const items: Array<vscode.QuickPickItem & { action: ProfileAction }> = [
    {
      label: "$(check) Use as active profile",
      description: profileId === activeProfile ? "already active" : "default for models without an assignment",
      action: "activate",
    },
    {
      label: "$(key) Set or replace API key",
      description: hasKey ? "A key is stored for this profile" : "No key stored for this profile",
      action: "setKey",
    },
  ];
  if (hasKey) {
    items.push({ label: "$(trash) Clear API key", description: "Remove it from SecretStorage", action: "clearKey" });
  }
  items.push(
    { label: "$(pencil) Rename profile", description: "Moves the key and its model assignments", action: "rename" },
    {
      label: "$(trash) Delete profile",
      description: "Removes its key and every profile::model assignment",
      action: "delete",
    },
  );

  const choice = await vscode.window.showQuickPick(items, {
    title: `NaN Builders profile "${profileId}"`,
    placeHolder: "Choose an action",
  });
  if (!choice) {
    return;
  }
  switch (choice.action) {
    case "activate": {
      await writeProfileSettings(settings.profiles, profileId);
      provider.refresh();
      vscode.window.showInformationMessage(`NaN Builders: profile "${profileId}" is now the active profile.`);
      return;
    }
    case "setKey": {
      const value = await vscode.window.showInputBox({
        title: `NaN Builders API Key for profile "${profileId}"`,
        prompt: `Paste the API key for profile "${profileId}". It is stored in VS Code SecretStorage.`,
        password: true,
        ignoreFocusOut: true,
        placeHolder: "sk-...",
      });
      if (!value?.trim()) {
        return;
      }
      await provider.setProfileKey(profileId, value.trim());
      await onKeyChanged?.();
      vscode.window.showInformationMessage(`NaN Builders: API key saved for profile "${profileId}".`);
      return;
    }
    case "clearKey":
      await provider.clearProfileKey(profileId);
      vscode.window.showInformationMessage(
        `NaN Builders: API key removed for profile "${profileId}". Requests that resolve to it now fail and name the profile.`,
      );
      return;
    case "rename":
      await renameProfile(provider, profileId, onKeyChanged);
      return;
    case "delete":
      await deleteProfile(context, provider, profileId, onKeyChanged);
      return;
  }
}

async function renameProfile(
  provider: NanChatModelProvider,
  profileId: string,
  onKeyChanged?: () => Promise<void>,
): Promise<void> {
  const settings = profileSettings();
  const enteredId = await vscode.window.showInputBox({
    title: `NaN Builders: rename profile "${profileId}"`,
    prompt: "New profile id. Its API key and model assignments move with it.",
    value: profileId,
    ignoreFocusOut: true,
    validateInput: (value) => {
      const trimmed = value.trim();
      if (!trimmed) {
        return "Enter a profile id.";
      }
      if (!isValidProfileId(trimmed)) {
        return `Use up to ${MAX_PROFILE_ID_LENGTH} characters: letters, digits, ".", "_" or "-", starting with a letter or digit.`;
      }
      if (trimmed !== profileId && settings.profiles.includes(trimmed)) {
        return `Profile "${trimmed}" already exists.`;
      }
      return undefined;
    },
  });
  const nextId = enteredId?.trim();
  if (!nextId || nextId === profileId) {
    return;
  }
  const profiles = settings.profiles.map((entry) => (entry === profileId ? nextId : entry));
  // The key moves before the settings do: if the secret move fails, nothing
  // points at an id whose key was never written.
  await provider.renameProfileSecret(profileId, nextId);
  await writeProfileSettings(profiles, nextActiveProfile(profiles, settings.activeProfile));
  await vscode.workspace
    .getConfiguration("nanBuilders")
    .update(
      "reasoningEffortByModel",
      renameProfileAssignments(effortOverrides(), profileId, nextId),
      vscode.ConfigurationTarget.Global,
    );
  provider.refresh();
  await onKeyChanged?.();
  vscode.window.showInformationMessage(
    `NaN Builders: profile "${profileId}" renamed to "${nextId}" (key and model assignments moved).`,
  );
}

async function deleteProfile(
  context: vscode.ExtensionContext,
  provider: NanChatModelProvider,
  profileId: string,
  onKeyChanged?: () => Promise<void>,
): Promise<void> {
  const settings = profileSettings();
  const overrides = effortOverrides();
  const assignedModels = Object.keys(overrides)
    .map((key) => parseProfileModelAssignment(key))
    .filter((assignment) => assignment?.profileId === profileId)
    .map((assignment) => assignment!.modelId);
  const confirmed = await vscode.window.showWarningMessage(
    `Delete NaN Builders profile "${profileId}"? Its API key is removed from SecretStorage and ` +
      `${assignedModels.length} model assignment(s) are cleared, so no request uses it afterwards.`,
    { modal: true },
    "Delete profile",
  );
  if (confirmed !== "Delete profile") {
    return;
  }
  const profiles = settings.profiles.filter((entry) => entry !== profileId);
  // Settings first: while the profile is gone from settings nothing can resolve
  // to it, even if a secret or an assignment is still being removed below.
  await writeProfileSettings(profiles, nextActiveProfile(profiles, settings.activeProfile));
  await provider.clearProfileKey(profileId);
  await vscode.workspace
    .getConfiguration("nanBuilders")
    .update("reasoningEffortByModel", removeProfileAssignments(overrides, profileId), vscode.ConfigurationTarget.Global);
  provider.refresh();
  await onKeyChanged?.();
  const remaining = resolveActiveProfile(profileSettings());
  vscode.window.showInformationMessage(
    `NaN Builders: profile "${profileId}" deleted with its API key and model assignments. ` +
      (remaining ? `Active profile: "${remaining}".` : "Models use the shared API key again."),
  );
}

/**
 * "Test Connection": silent, read-only model discovery for the stored key.
 * A missing key, no reachable models, or a gateway error each produce an
 * actionable warning; gateway text is sanitized before it is displayed.
 */
async function testConnection(provider: NanChatModelProvider): Promise<void> {
  const credential = await provider.configuredCredential();
  if (!credential.apiKey) {
    vscode.window.showWarningMessage(
      credential.profileId
        ? `NaN Builders profile "${credential.profileId}" has no API key. Run 'NaN Builders: Manage Provider' → Profiles to set it, then test the connection again.`
        : "No NaN Builders API key is configured. Run 'NaN Builders: Manage Provider' to add one, then test the connection again.",
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
  const settings = profileSettings();
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
      profiles: settings.profiles,
      activeProfile: resolveActiveProfile(settings),
      profileAssignments: Object.keys(effortOverrides())
        .map((key) => parseProfileModelAssignment(key))
        .filter((assignment): assignment is { profileId: string; modelId: string } => assignment !== undefined),
      failover: provider.failoverState(),
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

const SHOW_USAGE_ACTION = "Show Usage";

/** One warning per threshold crossing; "Show Usage" opens the account-usage QuickPick. */
async function warnLowCredits(remaining: RemainingCredits): Promise<void> {
  const percent = formatPercent(Math.round(remaining.percent * 10) / 10);
  const choice = await vscode.window.showWarningMessage(
    `NaN Builders: only ${percent}% of your plan credits remain ` +
      `(${formatCredits(remaining.remaining)} of ${formatCredits(remaining.allowance)}). ` +
      `Agent requests fail once the allowance is used up.`,
    SHOW_USAGE_ACTION,
  );
  if (choice === SHOW_USAGE_ACTION) {
    await vscode.commands.executeCommand("nanBuilders.showUsage");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function deactivate(): void {}
