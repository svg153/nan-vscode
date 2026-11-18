/**
 * Pure QuickPick model for "NaN Builders: Set Inline Completion Model".
 *
 * Deliberately free of `vscode` imports so the rows and the resulting setting
 * value can be unit tested without a VS Code host.
 */

/** A discovered model as the picker needs it. */
export interface CompletionModelOption {
  readonly id: string;
  readonly name?: string;
}

/**
 * One row of the completion-model picker. `model` is the exact value written to
 * `nanBuilders.completionModel`; the empty string is the "disable" row.
 */
export interface CompletionModelPickItem {
  readonly model: string;
  readonly label: string;
  readonly description?: string;
  readonly detail?: string;
}

export const DISABLE_COMPLETION_MODEL_LABEL = "Disable inline completions";

/**
 * Discovered models (blank ids dropped, first occurrence wins) followed by the
 * disable row. The configured model is marked so re-running the command shows
 * the active choice; the disable row always exists so the toggle is symmetric.
 */
export function buildCompletionModelPickItems(
  models: readonly CompletionModelOption[],
  currentModel: string,
): CompletionModelPickItem[] {
  const current = currentModel.trim();
  const seen = new Set<string>();
  const items: CompletionModelPickItem[] = [];
  for (const { id, name } of models) {
    const model = id.trim();
    if (!model || seen.has(model)) {
      continue;
    }
    seen.add(model);
    const label = name?.trim() || model;
    const isCurrent = model === current;
    const description = [label === model ? undefined : model, isCurrent ? "$(checkmark) current" : undefined]
      .filter((part): part is string => Boolean(part))
      .join(" · ");
    items.push({
      model,
      label,
      description: description || undefined,
      detail: isCurrent ? "Inline completions already use this model." : undefined,
    });
  }
  items.push({
    model: "",
    label: DISABLE_COMPLETION_MODEL_LABEL,
    description: current ? "Clears nanBuilders.completionModel" : "Inline completions are already off",
    detail: current ? `Stops sending ghost-text requests from ${current}.` : undefined,
  });
  return items;
}

/**
 * Setting value for a picked row: the model id, `""` for the disable row, and
 * `undefined` when the QuickPick was dismissed (so nothing is written).
 */
export function completionModelFromPick(item: CompletionModelPickItem | undefined): string | undefined {
  return item?.model;
}
