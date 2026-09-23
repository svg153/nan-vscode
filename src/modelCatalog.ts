export interface ModelMetadata {
  readonly id: string;
  readonly name: string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly imageInput: boolean;
  readonly toolCalling: boolean;
  readonly premium?: boolean;
}

const CHAT_MODELS: readonly ModelMetadata[] = [
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    contextWindow: 1_048_575,
    maxOutputTokens: 32_768,
    imageInput: true,
    toolCalling: true,
  },
  {
    id: "glm5.3-flash",
    name: "GLM 5.3 Flash",
    contextWindow: 1_048_576,
    maxOutputTokens: 32_768,
    imageInput: true,
    toolCalling: true,
  },
  {
    id: "qwen3.8-flash",
    name: "Qwen 3.8 Flash",
    contextWindow: 262_144,
    maxOutputTokens: 32_768,
    imageInput: true,
    toolCalling: true,
  },
  {
    id: "mimo-v2.5",
    name: "Xiaomi MiMo V2.5",
    contextWindow: 1_048_576,
    maxOutputTokens: 32_768,
    imageInput: true,
    toolCalling: true,
  },
  {
    id: "gemma4",
    name: "Gemma 4",
    contextWindow: 262_144,
    maxOutputTokens: 65_536,
    imageInput: true,
    toolCalling: true,
  },
  {
    id: "qwen3.6",
    name: "Qwen 3.6",
    contextWindow: 262_144,
    maxOutputTokens: 65_536,
    imageInput: true,
    toolCalling: true,
  },
  {
    id: "glm5.3",
    name: "GLM 5.3",
    contextWindow: 1_048_576,
    maxOutputTokens: 32_768,
    imageInput: false,
    toolCalling: true,
    premium: true,
  },
] as const;

const KNOWN_NON_CHAT_IDS = new Set([
  "qwen3-embedding",
  "rerank",
  "kokoro",
  "whisper",
  "flux-2-klein",
]);

const BY_ID = new Map(CHAT_MODELS.map((model) => [model.id, model]));

export function knownChatModelIds(): string[] {
  return CHAT_MODELS.map((model) => model.id);
}

export function getKnownModel(id: string): ModelMetadata | undefined {
  return BY_ID.get(id);
}

export function isKnownNonChatModel(id: string): boolean {
  return KNOWN_NON_CHAT_IDS.has(id);
}

export function toDisplayMetadata(id: string): ModelMetadata {
  const known = getKnownModel(id);
  if (known) {
    return known;
  }

  return {
    id,
    name: id,
    contextWindow: 128_000,
    maxOutputTokens: 16_000,
    imageInput: false,
    toolCalling: false,
  };
}

export function filterDiscoveredModelIds(ids: readonly string[], includeUnknownModels: boolean): string[] {
  const unique = new Set<string>();

  for (const rawId of ids) {
    const id = rawId.trim();
    if (!id || isKnownNonChatModel(id)) {
      continue;
    }
    if (getKnownModel(id) || includeUnknownModels) {
      unique.add(id);
    }
  }

  return [...unique];
}
