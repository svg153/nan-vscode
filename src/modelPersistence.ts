import { parseDiscoveredModel, type DiscoveredModel } from "./modelCatalog";

/** `globalState` key holding the last successful live discovery result. */
export const PERSISTED_MODELS_KEY = "nanBuilders.lastDiscoveredModels";

/** Envelope schema version. Unknown versions are ignored, never guessed. */
export const PERSISTED_MODELS_VERSION = 1;

/**
 * Safety bound for the fallback catalog. The persisted list only serves the
 * picker while live discovery is failing, so it is discarded once it is older
 * than this rather than showing an indefinitely stale catalog as fallback.
 */
export const MAX_PERSISTED_MODEL_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface PersistedModelList {
  readonly version: number;
  readonly savedAt: number;
  readonly models: readonly DiscoveredModel[];
}

/**
 * Serializes discovered models for `globalState` storage. Entries are rebuilt
 * through `parseDiscoveredModel`, so only ids and the documented metadata
 * fields are kept; credentials, headers and endpoints never leave discovery.
 */
export function serializeModelList(
  models: readonly DiscoveredModel[],
  savedAt: number = Date.now(),
): string {
  const cleaned: DiscoveredModel[] = [];
  for (const model of models) {
    const parsed = parseDiscoveredModel(model);
    if (parsed) {
      cleaned.push(parsed);
    }
  }
  const envelope: PersistedModelList = {
    version: PERSISTED_MODELS_VERSION,
    savedAt,
    models: cleaned,
  };
  return JSON.stringify(envelope);
}

/**
 * Parses a persisted list, returning its valid entries or `undefined` when the
 * data is corrupted, uses an unknown schema version, is older than
 * `MAX_PERSISTED_MODEL_AGE_MS`, or has no valid model left. Individual
 * malformed entries are dropped instead of discarding the whole list.
 */
export function parsePersistedModelList(raw: unknown, now: number = Date.now()): DiscoveredModel[] | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }

  const envelope = parsed as Record<string, unknown>;
  if (envelope.version !== PERSISTED_MODELS_VERSION) {
    return undefined;
  }

  const savedAt = envelope.savedAt;
  if (typeof savedAt !== "number" || !Number.isFinite(savedAt)) {
    return undefined;
  }
  const age = now - savedAt;
  // A timestamp from the future means the clock moved backwards, so the data
  // cannot be trusted to be recent.
  if (age < 0 || age > MAX_PERSISTED_MODEL_AGE_MS) {
    return undefined;
  }

  if (!Array.isArray(envelope.models)) {
    return undefined;
  }

  const seen = new Set<string>();
  const models: DiscoveredModel[] = [];
  for (const entry of envelope.models) {
    const model = parseDiscoveredModel(entry);
    if (!model || seen.has(model.id)) {
      continue;
    }
    seen.add(model.id);
    models.push(model);
  }

  return models.length > 0 ? models : undefined;
}
