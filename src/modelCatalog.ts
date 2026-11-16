export interface ModelMetadata {
  readonly id: string;
  readonly name: string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly imageInput: boolean;
  readonly toolCalling: boolean;
  readonly premium?: boolean;
  /**
   * Documented reasoning levels for chat completions. Empty means the model
   * accepts the parameter but manages reasoning depth itself; `undefined`
   * means the model is not in the curated catalog. The ladders below were
   * copied from the "Controlling reasoning" table at
   * https://nan.builders/docs/models on 2026-11-16. `/v1/models` does not
   * publish per-model effort levels today, so this table is the source of
   * truth and must be re-checked when the docs change.
   */
  readonly reasoningEffortValues?: readonly string[];
}

/**
 * Optional capability fields returned by NaN's `/v1/models` endpoint.
 * All fields except `id` are optional because older responses may not include them.
 */
export interface DiscoveredModel {
  readonly id: string;
  readonly model_type?: string;
  readonly is_chat?: boolean;
  readonly context_window?: number;
  readonly max_output_tokens?: number;
  readonly image_support?: boolean;
  readonly tool_calling?: boolean;
  readonly capabilities?: readonly string[];
}

interface ResolvedModelMetadata extends ModelMetadata {
  readonly _api?: DiscoveredModel;
}

const CHAT_MODELS: readonly ModelMetadata[] = [
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    contextWindow: 1_048_575,
    maxOutputTokens: 32_768,
    imageInput: true,
    toolCalling: true,
    // Docs: none turns reasoning off; minimal..max steer depth as hints, not caps.
    reasoningEffortValues: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "glm5.3-flash",
    name: "GLM 5.3 Flash",
    contextWindow: 1_048_576,
    maxOutputTokens: 32_768,
    imageInput: true,
    toolCalling: true,
    // Docs: GLM always reasons; there is no off switch and "none" is applied as "minimal".
    reasoningEffortValues: ["minimal", "low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "qwen3.8-flash",
    name: "Qwen 3.8 Flash",
    contextWindow: 1_048_576,
    maxOutputTokens: 32_768,
    imageInput: true,
    // NaN documents XML tool calls; this provider currently only handles OpenAI tool_calls.
    toolCalling: false,
    // Docs: reasoning is on by default, "none" turns it off, minimal..max are hints, not caps.
    reasoningEffortValues: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "mimo-v2.6-flash",
    name: "Xiaomi MiMo V2.6 Flash",
    contextWindow: 1_048_576,
    maxOutputTokens: 32_768,
    imageInput: true,
    toolCalling: true,
    // Docs: low..max only; "none" turns reasoning off, "minimal" is applied as "low", "xhigh" as "max".
    reasoningEffortValues: ["none", "low", "medium", "high", "max"],
  },
  {
    id: "gemma4",
    name: "Gemma 4",
    contextWindow: 262_144,
    maxOutputTokens: 65_536,
    imageInput: true,
    toolCalling: false,
    // Docs: both "none" and "minimal" disable reasoning; low..max cap the reasoning phase.
    reasoningEffortValues: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "qwen3.6",
    name: "Qwen 3.6",
    contextWindow: 262_144,
    maxOutputTokens: 65_536,
    imageInput: true,
    toolCalling: false,
    // Docs: both "none" and "minimal" disable reasoning; low..max cap the reasoning phase.
    reasoningEffortValues: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "glm5.3",
    name: "GLM 5.3",
    contextWindow: 1_048_576,
    maxOutputTokens: 32_768,
    imageInput: false,
    toolCalling: true,
    premium: true,
    // Docs: GLM always reasons; there is no off switch and "none" is applied as "minimal".
    reasoningEffortValues: ["minimal", "low", "medium", "high", "xhigh", "max"],
  },
] as const;

const KNOWN_NON_CHAT_IDS = new Set([
  "qwen3-embedding",
  "rerank",
  "kokoro",
  "whisper",
  "flux-2-klein",
  "qwen-image-2.1",
]);

const CHAT_MODEL_TYPES = new Set(["chat", "llm", "text"]);

/**
 * Determine whether a discovered model should be treated as a chat model.
 * Uses documented metadata when available, falls back to the local catalog
 * and the denylist for older/partial responses.
 */
function isChatModel(model: DiscoveredModel, includeUnknown: boolean): boolean {
  const id = model.id.trim();
  if (!id || isKnownNonChatModel(id)) {
    return false;
  }

  // Explicit metadata from the API takes precedence.
  if (model.is_chat === false) {
    return false;
  }
  if (model.is_chat === true) {
    return true;
  }
  if (model.model_type !== undefined && typeof model.model_type === "string") {
    if (CHAT_MODEL_TYPES.has(model.model_type.toLowerCase())) {
      return true;
    }
    // Explicit non-chat type
    return false;
  }

  // No metadata: fall back to the local catalog or the denylist.
  if (getKnownModel(id)) {
    return true;
  }
  return includeUnknown;
}

const BY_ID = new Map(CHAT_MODELS.map((model) => [model.id, model]));

export function knownChatModelIds(): string[] {
  return CHAT_MODELS.map((model) => model.id);
}

export function getKnownModel(id: string): ModelMetadata | undefined {
  return BY_ID.get(id);
}

export function reasoningDescription(model: ModelMetadata): string {
  const values = model.reasoningEffortValues;
  const note = reasoningLevelNotes(model.id);
  if (values === undefined) {
    return "Reasoning support is unknown.";
  }
  if (values.length === 0) {
    return `Reasoning depth is model-managed; effort levels are not user-adjustable.${note ? ` Note: ${note}` : ""}`;
  }
  return [
    `Documented reasoning effort levels: ${values.join(", ")}.`,
    `Defaults to '${defaultReasoningEffortForModel(values)}' under nanBuilders.defaultReasoningEffort = auto; pick a per-model level with 'NaN Builders: Set Model Reasoning Effort'.`,
    ...(note ? [`Note: ${note}`] : []),
  ].join(" ");
}

export function isKnownNonChatModel(id: string): boolean {
  return KNOWN_NON_CHAT_IDS.has(id);
}

/** Canonical low-to-high order used to find the nearest documented level. */
const REASONING_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Levels accepted from requests/settings; words above "max" clamp to it. */
const REASONING_WORDS = /^(none|minimal|low|medium|high|max|xhigh)$/;

export interface ResolveReasoningEffortInput {
  /** Effort coming from the chat request (`modelOptions.reasoning_effort`). */
  readonly requested?: string;
  /** Per-model override chosen with the Set Model Reasoning Effort command. */
  readonly perModelOverride?: string;
  /** `nanBuilders.defaultReasoningEffort`; "auto" defers to the model default. */
  readonly globalDefault?: string;
  /** Documented ladder. `undefined` = unknown model, `[]` = model-managed. */
  readonly ladder?: readonly string[];
}

function effortRank(level: string): number {
  const index = (REASONING_ORDER as readonly string[]).indexOf(level);
  // Any above-max word sorts after "max".
  return index >= 0 ? index : REASONING_ORDER.length;
}

/**
 * Map a valid effort word to the closest level of `ladder`. Unknown levels are
 * elevated to the nearest real one instead of being rejected or ignored
 * (e.g. with a low..max ladder: none/minimal -> low, xhigh -> max).
 * Ties prefer the higher level.
 */
export function remapReasoningEffort(level: string, ladder: readonly string[]): string {
  if (ladder.length === 0 || ladder.includes(level)) {
    return level;
  }
  const rank = effortRank(level);
  let best = ladder[0];
  let bestDistance = Math.abs(effortRank(best) - rank);
  for (const candidate of ladder) {
    const distance = Math.abs(effortRank(candidate) - rank);
    if (distance < bestDistance || (distance === bestDistance && effortRank(candidate) > effortRank(best))) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Per-model default: "medium" when the model documents it, otherwise the
 * central level of its documented ladder. Falls back to "low" for
 * model-managed or unknown models.
 */
export function defaultReasoningEffortForModel(ladder: readonly string[] | undefined): string {
  if (!ladder || ladder.length === 0) {
    return "low";
  }
  if (ladder.includes("medium")) {
    return "medium";
  }
  return ladder[Math.floor((ladder.length - 1) / 2)];
}

/**
 * Resolve the effort to send: request override > per-model override >
 * explicit global default > model default. The result is always remapped to
 * the model's documented ladder (canonical levels for unknown or
 * model-managed models).
 */
export function resolveReasoningEffort(input: ResolveReasoningEffortInput): string {
  const word = (value: string | undefined): string | undefined =>
    value !== undefined && REASONING_WORDS.test(value) ? value : undefined;
  const globalDefault = input.globalDefault === "auto" ? undefined : word(input.globalDefault);
  const candidate = word(input.requested) ?? word(input.perModelOverride) ?? globalDefault
    ?? defaultReasoningEffortForModel(input.ladder);
  return remapReasoningEffort(candidate, input.ladder && input.ladder.length > 0 ? input.ladder : [...REASONING_ORDER]);
}

const REASONING_LEVEL_NOTES: readonly (readonly [string, string])[] = [
  ["deepseek-v4-flash", "DeepSeek Flash: effort values steer depth as hints, not caps; 'none' turns reasoning off."],
  ["qwen3.8-flash", "Qwen3.8 Flash: reasoning is on by default; 'none' turns it off and effort values are hints, not caps. 'max_tokens' bounds only the answer; use 'max_completion_tokens' for the total."],
  ["mimo-v2.6-flash", "MiMo counts reasoning tokens inside max_tokens; 'minimal' is applied as 'low' and 'xhigh' as 'max'."],
  ["gemma4", "Gemma: both 'none' and 'minimal' disable reasoning; on Chat Completions levels cap the reasoning phase at 2,048-32,768 tokens."],
  ["qwen3.6", "Qwen3.6: both 'none' and 'minimal' disable reasoning; on Chat Completions levels cap the reasoning phase at 2,048-32,768 tokens."],
  ["glm5.3-flash", "GLM always reasons; there is no off switch and 'none' is applied as 'minimal'."],
  ["glm5.3", "GLM always reasons; there is no off switch and 'none' is applied as 'minimal'."],
];

export function reasoningLevelNotes(id: string): string | undefined {
  return REASONING_LEVEL_NOTES.find(([modelId]) => modelId === id)?.[1];
}

/**
 * Parse and validate a raw model entry from the `/v1/models` response.
 * Returns `undefined` when the entry has no valid string id.
 */
export function parseDiscoveredModel(raw: unknown): DiscoveredModel | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id.trim() : undefined;
  if (!id) {
    return undefined;
  }

  // Build with a plain mutable object, then cast to DiscoveredModel.
  const result: Record<string, unknown> = { id };

  if (typeof obj.model_type === "string") {
    result.model_type = obj.model_type;
  }
  if (typeof obj.is_chat === "boolean") {
    result.is_chat = obj.is_chat;
  }
  if (typeof obj.context_window === "number" && Number.isFinite(obj.context_window) && obj.context_window > 0) {
    result.context_window = obj.context_window;
  }
  if (
    typeof obj.max_output_tokens === "number" &&
    Number.isFinite(obj.max_output_tokens) &&
    obj.max_output_tokens > 0
  ) {
    result.max_output_tokens = obj.max_output_tokens;
  }
  if (typeof obj.image_support === "boolean") {
    result.image_support = obj.image_support;
  }
  if (typeof obj.tool_calling === "boolean") {
    result.tool_calling = obj.tool_calling;
  }
  if (Array.isArray(obj.capabilities)) {
    result.capabilities = obj.capabilities.filter((c): c is string => typeof c === "string");
  }

  return result as unknown as DiscoveredModel;
}

/**
 * Filter discovered models, keeping only chat models.
 * Uses documented metadata when available, falls back to the local catalog
 * and the denylist for older/partial responses.
 */
export function filterDiscoveredModels(
  rawModels: readonly unknown[],
  includeUnknown: boolean,
): DiscoveredModel[] {
  const unique = new Map<string, DiscoveredModel>();

  for (const raw of rawModels) {
    const model = parseDiscoveredModel(raw);
    if (!model || unique.has(model.id)) {
      continue;
    }
    if (isChatModel(model, includeUnknown)) {
      unique.set(model.id, model);
    }
  }

  return [...unique.values()];
}

/**
 * Legacy wrapper that maps an array of raw id strings to a filtered list.
 * Kept for backward compatibility with existing tests.
 */
export function filterDiscoveredModelIds(ids: readonly string[], includeUnknown: boolean): string[] {
  const unique = new Set<string>();

  for (const rawId of ids) {
    const id = rawId.trim();
    if (!id || isKnownNonChatModel(id)) {
      continue;
    }
    if (getKnownModel(id) || includeUnknown) {
      unique.add(id);
    }
  }

  return [...unique];
}

/**
 * Merge API metadata with the local catalog, falling back to conservative defaults.
 * Catalog values for toolCalling win when the catalog explicitly disables it
 * (e.g. XML-only models), even if the API reports tool_calling: true.
 */
export function toDisplayMetadata(id: string, api?: DiscoveredModel): ModelMetadata {
  const known = getKnownModel(id);

  // Determine contextWindow: API > catalog > default
  const contextWindow =
    typeof api?.context_window === "number" && Number.isFinite(api.context_window) && api.context_window > 0
      ? api.context_window
      : known?.contextWindow ?? 128_000;

  // Determine maxOutputTokens: API > catalog > default, clamped to contextWindow - 1
  const rawMaxOutput =
    typeof api?.max_output_tokens === "number" && Number.isFinite(api.max_output_tokens) && api.max_output_tokens > 0
      ? api.max_output_tokens
      : known?.maxOutputTokens ?? 16_000;
  const maxOutputTokens = Math.min(rawMaxOutput, contextWindow - 1);

  // Determine imageInput: API > catalog > default
  const imageInput =
    typeof api?.image_support === "boolean"
      ? api.image_support
      : known?.imageInput ?? false;

  // Determine toolCalling: catalog wins when it explicitly disables (XML-only models)
  let toolCalling: boolean;
  if (known?.toolCalling === false) {
    toolCalling = false;
  } else if (typeof api?.tool_calling === "boolean") {
    toolCalling = api.tool_calling;
  } else {
    toolCalling = known?.toolCalling ?? false;
  }

  return {
    id,
    name: known?.name ?? id,
    contextWindow,
    maxOutputTokens,
    imageInput,
    toolCalling,
    premium: known?.premium,
    reasoningEffortValues: known?.reasoningEffortValues,
  };
}
