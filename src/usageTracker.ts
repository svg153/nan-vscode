import * as vscode from "vscode";
import { diagnostic } from "./diagnostics";
import type { OpenAIUsage } from "./openai/types";
import { quotaSummaryItems } from "./quotaCatalog";
import { addUsage, formatHistory, normalizeHistory, type DailyUsage } from "./usageHistory";

const HISTORY_KEY = "nanBuilders.localUsageHistory";

export class UsageTracker implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private promptTokens = 0;
  private completionTokens = 0;
  private requests = 0;
  private lastModel: string | undefined;
  private readonly modelUsage = new Map<string, { requests: number; tokens: number }>();
  private history: DailyUsage[];
  private persistQueue = Promise.resolve(true);

  constructor(private readonly storage: vscode.Memento) {
    this.history = normalizeHistory(storage.get<unknown>(HISTORY_KEY));
    void this.persist();
    diagnostic("statusBar.create.begin");
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
    this.item.command = "nanBuilders.showUsage";
    this.refreshVisibility();
    diagnostic("statusBar.create.complete");
  }

  async record(modelId: string, usage: OpenAIUsage | undefined): Promise<void> {
    this.requests += 1;
    this.lastModel = modelId;
    this.promptTokens += usage?.prompt_tokens ?? 0;
    this.completionTokens += usage?.completion_tokens ?? 0;
    const model = this.modelUsage.get(modelId) ?? { requests: 0, tokens: 0 };
    model.requests += 1;
    model.tokens += (usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0);
    this.modelUsage.set(modelId, model);
    this.history = addUsage(this.history, modelId, usage);
    this.render();
    await this.persist();
  }

  async clearHistory(): Promise<boolean> {
    this.history = [];
    this.modelUsage.clear();
    this.requests = 0;
    this.promptTokens = 0;
    this.completionTokens = 0;
    this.lastModel = undefined;
    const saved = await this.persist();
    this.render();
    return saved;
  }

  quotaItems(): vscode.QuickPickItem[] {
    return quotaSummaryItems(this.modelUsage);
  }

  historyItems(): vscode.QuickPickItem[] {
    if (this.history.length === 0) return [{ label: "No local daily usage history yet" }];
    return this.history.slice(0, 20).map((row) => ({
      label: `${row.date} · ${row.modelId}`,
      description: `${row.requests} request(s) · prompt ${row.promptTokens.toLocaleString()} + completion ${row.completionTokens.toLocaleString()}`,
      detail: "Observed by this VS Code extension and stored locally; not account-wide usage.",
    }));
  }

  refreshVisibility(): void {
    const enabled = vscode.workspace.getConfiguration("nanBuilders").get<boolean>("showStatusBar", true);
    diagnostic("statusBar.visibility", { enabled });
    if (enabled) {
      this.item.show();
      this.render();
    } else {
      this.item.hide();
    }
  }

  summary(): string {
    const total = this.promptTokens + this.completionTokens;
    const model = this.lastModel ? `\nLast model: ${this.lastModel}` : "";
    return [
      "NaN Builders local VS Code session usage",
      `Requests: ${this.requests}`,
      `Prompt tokens: ${this.promptTokens.toLocaleString()}`,
      `Completion tokens: ${this.completionTokens.toLocaleString()}`,
      `Total tokens: ${total.toLocaleString()}`,
      model,
      "",
      ...this.quotaItems().map((item) => `${item.label}: ${item.description}`),
      "",
      "Local usage is only what this VS Code extension observed this session; it is not account-wide usage or remaining quota.",
      "Local history (last 30 days):",
      formatHistory(this.history.slice(0, 20)),
      "",
      "This is local session usage only, not your account-wide NaN quota.",
    ].join("\n");
  }

  dispose(): void {
    diagnostic("statusBar.dispose");
    this.item.dispose();
  }

  private render(): void {
    const total = this.promptTokens + this.completionTokens;
    this.item.text = total > 0 ? `$(graph) NaN ${compact(total)}` : "$(sparkle) NaN";
    this.item.tooltip = this.summary();
  }

  private persist(): Promise<boolean> {
    const snapshot = this.history.map((row) => ({ ...row }));
    this.persistQueue = this.persistQueue.then(async () => {
      try {
        await this.storage.update(HISTORY_KEY, snapshot);
        return true;
      } catch (error) {
        diagnostic("usageHistory.persist.error", { errorName: error instanceof Error ? error.name : typeof error });
        return false;
      }
    });
    return this.persistQueue;
  }
}

function compact(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  }
  return String(value);
}
