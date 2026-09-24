export interface ToolNameMappings {
  readonly originalToSanitized: ReadonlyMap<string, string>;
  readonly sanitizedToOriginal: ReadonlyMap<string, string>;
}

export function buildToolNameMappings(names: readonly string[]): ToolNameMappings {
  const originalToSanitized = new Map<string, string>();
  const sanitizedToOriginal = new Map<string, string>();
  const used = new Set<string>();

  for (const original of names) {
    const base = sanitizeToolName(original);
    let sanitized = base;
    let suffix = 2;
    while (used.has(sanitized)) {
      const suffixText = `_${suffix++}`;
      sanitized = `${base.slice(0, Math.max(1, 64 - suffixText.length))}${suffixText}`;
    }
    used.add(sanitized);
    originalToSanitized.set(original, sanitized);
    sanitizedToOriginal.set(sanitized, original);
  }

  return { originalToSanitized, sanitizedToOriginal };
}

export function sanitizeToolName(name: string): string {
  let sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_");
  if (!/^[a-zA-Z]/.test(sanitized)) {
    sanitized = `tool_${sanitized}`;
  }
  return sanitized.slice(0, 64) || "tool";
}

export function sanitizeSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object", properties: {} };
  }

  try {
    return JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
  } catch {
    return { type: "object", properties: {} };
  }
}
