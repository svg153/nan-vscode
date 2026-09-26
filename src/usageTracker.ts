import * as vscode from "vscode";
import { diagnostic } from "./diagnostics";
import type { OpenAIUsage } from "./openai/types";
import { quotaSummaryItems } from "./quotaCatalog";

export class UsageTracker implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private promptTokens = 0;
  private completionTokens = 0;
  private requests = 0;
  private lastModel: string | undefined;
  private readonly modelUsage = new Map<string, { requests: number; tokens: number }>();

  constructor() {
    diagnostic("statusBar.create.begin");
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
    this.item.command = "nanBuilders.showUsage";
    this.refreshVisibility();
    diagnostic("statusBar.create.complete");
  }

  record(modelId: string, usage: OpenAIUsage | undefined): void {
    this.requests += 1;
    this.lastModel = modelId;
    this.promptTokens += usage?.prompt_tokens ?? 0;
    this.completionTokens += usage?.completion_tokens ?? 0;
    const model = this.modelUsage.get(modelId) ?? { requests: 0, tokens: 0 };
    model.requests += 1;
    model.tokens += (usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0);
    this.modelUsage.set(modelId, model);
    this.render();
  }

  quotaItems(): vscode.QuickPickItem[] {
    return quotaSummaryItems(this.modelUsage);
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
