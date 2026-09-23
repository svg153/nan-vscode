import * as vscode from "vscode";
import type { OpenAIUsage } from "./openai/types";

export class UsageTracker implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private promptTokens = 0;
  private completionTokens = 0;
  private requests = 0;
  private lastModel: string | undefined;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
    this.item.command = "nanBuilders.showUsage";
    this.refreshVisibility();
  }

  record(modelId: string, usage: OpenAIUsage | undefined): void {
    this.requests += 1;
    this.lastModel = modelId;
    this.promptTokens += usage?.prompt_tokens ?? 0;
    this.completionTokens += usage?.completion_tokens ?? 0;
    this.render();
  }

  refreshVisibility(): void {
    const enabled = vscode.workspace.getConfiguration("nanBuilders").get<boolean>("showStatusBar", true);
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
      "This is local session usage only, not your account-wide NaN quota.",
    ].join("\n");
  }

  dispose(): void {
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
