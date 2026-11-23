/**
 * Pure Quick Pick model for "NaN Builders: Show Available Models".
 *
 * Kept free of `vscode` imports so the rows can be unit tested without a host.
 */

/** One discovered chat model as the picker needs it. */
export interface AvailableModelOption {
  readonly id: string;
  readonly name?: string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly imageInput: boolean;
  readonly toolCalling: boolean;
  readonly largerModel?: boolean;
}

/** One picker row; `model` is the id copied when the row is selected. */
export interface AvailableModelPickItem {
  readonly model: string;
  readonly label: string;
  readonly description: string;
  readonly detail: string;
}

/**
 * Formats discovered chat models for the clipboard picker. Blank ids are
 * dropped and the first occurrence of a duplicate id wins, so a gateway that
 * lists the same model twice produces one row.
 */
export function buildAvailableModelPickItems(
  models: readonly AvailableModelOption[],
): AvailableModelPickItem[] {
  const seen = new Set<string>();
  const items: AvailableModelPickItem[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const name = model.name?.trim() || id;
    const description = [
      name === id ? undefined : id,
      `${formatTokenCount(model.contextWindow)} context`,
    ]
      .filter((part): part is string => Boolean(part))
      .join(" · ");
    items.push({ model: id, label: name, description, detail: formatCapabilities(model) });
  }
  return items;
}

/** `1048576` -> `1,048,576`. Locale-independent so the UI and tests agree. */
export function formatTokenCount(tokens: number): string {
  const rounded = Math.max(0, Math.round(tokens));
  return rounded.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatCapabilities(model: AvailableModelOption): string {
  const parts = [
    `${formatTokenCount(model.maxOutputTokens)} max output`,
    model.imageInput ? "image input" : "text-only input",
    model.toolCalling ? "tool calling" : "no tool calling",
  ];
  if (model.largerModel) {
    parts.push("larger model (costs more per token)");
  }
  return parts.join(" · ");
}
