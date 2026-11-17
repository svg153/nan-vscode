/**
 * Per-profile API keys with `profile::model` routing.
 *
 * Kept free of the `vscode` module so resolution, cleanup, and the
 * diagnostics-safe projection can be unit-tested without a VS Code host.
 *
 * There is exactly one store for routing: `nanBuilders.reasoningEffortByModel`
 * already maps a model id to a reasoning effort, and composite keys hold
 * `profile::model`. Plain model ids cannot contain `::`, so the two shapes
 * cannot collide, and no second table is introduced. The value of a composite
 * entry is the reasoning effort for that model under that profile; `auto`
 * means "no effort override, routing only".
 */

/** Prefix of the SecretStorage entry holding one profile's API key. */
export const PROFILE_SECRET_PREFIX = "nanBuilders.profileKey.";
/** Separator between the profile id and the model id in an override key. */
export const PROFILE_MODEL_SEPARATOR = "::";
/** Override value that keeps the model's normal effort resolution. */
export const AUTO_EFFORT = "auto";
/** Upper bound for a profile id, so settings and secret names stay readable. */
export const MAX_PROFILE_ID_LENGTH = 32;

const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface ProfileSettings {
  /** Configured profile ids, in settings order. Never contains keys. */
  readonly profiles: readonly string[];
  /** Profile used for models without a `profile::model` assignment. */
  readonly activeProfile?: string;
}

/**
 * Why a profile was chosen. `"failover"` marks a benign retry with another
 * profile after the routed one was rate limited (#144).
 */
export type ProfileRouteSource = "legacy" | "assignment" | "active" | "first" | "failover";

/** Which profile key serves one request. `profileId` absent means the legacy key. */
export interface ModelRoute {
  readonly profileId?: string;
  readonly source: ProfileRouteSource;
}

/** True for a non-empty, trim-stable id that can live in a settings entry. */
export function isValidProfileId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_PROFILE_ID_LENGTH &&
    PROFILE_ID_PATTERN.test(value) &&
    value === value.trim()
  );
}

/**
 * Normalizes the `nanBuilders.profiles` setting: invalid and duplicate ids are
 * dropped so a hand-edited value cannot make SecretStorage names ambiguous.
 */
export function normalizeProfileIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const entry of value) {
    const id = typeof entry === "string" ? entry.trim() : "";
    if (!isValidProfileId(id) || seen.has(id)) {
      continue;
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/** SecretStorage name holding the key of one profile. */
export function profileSecretName(profileId: string): string {
  return `${PROFILE_SECRET_PREFIX}${profileId}`;
}

/** Profile id encoded in a SecretStorage name, or `undefined` for other secrets. */
export function parseProfileSecretName(name: string): string | undefined {
  if (!name.startsWith(PROFILE_SECRET_PREFIX)) {
    return undefined;
  }
  const id = name.slice(PROFILE_SECRET_PREFIX.length);
  return isValidProfileId(id) ? id : undefined;
}

/**
 * Reads the stored credential for diagnostics, account usage, and Test
 * Connection: the active profile's key when profiles exist, else the legacy
 * shared key. A missing key is reported by the caller, never invented here.
 */
export async function readConfiguredCredential(
  settings: ProfileSettings,
  readSecret: (name: string) => string | undefined | PromiseLike<string | undefined>,
  legacySecretName: string,
): Promise<{ apiKey: string | undefined; profileId: string | undefined }> {
  const profileId = resolveActiveProfile(settings);
  if (!profileId) {
    return { apiKey: await readSecret(legacySecretName), profileId: undefined };
  }
  return { apiKey: await readSecret(profileSecretName(profileId)), profileId };
}

/** Splits an override key into its profile and model halves. */
export function parseProfileModelAssignment(key: string): { profileId: string; modelId: string } | undefined {
  const separator = key.indexOf(PROFILE_MODEL_SEPARATOR);
  if (separator <= 0) {
    return undefined;
  }
  const profileId = key.slice(0, separator);
  const modelId = key.slice(separator + PROFILE_MODEL_SEPARATOR.length);
  if (!isValidProfileId(profileId) || !modelId) {
    return undefined;
  }
  return { profileId, modelId };
}

/**
 * Profile the model is explicitly assigned to. Entries naming a profile that is
 * no longer configured are ignored, so a request can never use a deleted
 * profile even when a stale override survived.
 */
export function assignedProfileForModel(
  overrides: Record<string, unknown> | undefined,
  modelId: string,
  profiles?: readonly string[],
): string | undefined {
  for (const key of Object.keys(overrides ?? {})) {
    const assignment = parseProfileModelAssignment(key);
    if (!assignment || assignment.modelId !== modelId) {
      continue;
    }
    if (profiles && !profiles.includes(assignment.profileId)) {
      continue;
    }
    return assignment.profileId;
  }
  return undefined;
}

/** Profile used for every model without an assignment; `undefined` means legacy. */
export function resolveActiveProfile(settings: ProfileSettings): string | undefined {
  const configured = typeof settings.activeProfile === "string" ? settings.activeProfile.trim() : "";
  if (configured && settings.profiles.includes(configured)) {
    return configured;
  }
  return settings.profiles[0];
}

/**
 * Resolves which key serves `modelId`. With no profiles configured the legacy
 * `nanBuilders.apiKey` keeps working exactly as before, so no migration is
 * required and existing installs are unaffected.
 */
export function resolveModelRoute(
  settings: ProfileSettings,
  overrides: Record<string, unknown> | undefined,
  modelId: string,
): ModelRoute {
  if (settings.profiles.length === 0) {
    return { source: "legacy" };
  }
  const assigned = assignedProfileForModel(overrides, modelId, settings.profiles);
  if (assigned) {
    return { profileId: assigned, source: "assignment" };
  }
  const active = resolveActiveProfile(settings);
  const configured = typeof settings.activeProfile === "string" ? settings.activeProfile.trim() : "";
  return { profileId: active, source: active !== undefined && active === configured ? "active" : "first" };
}

/**
 * Ordered key candidates for opt-in failover (#144): the route
 * `resolveModelRoute` picks first, then every other configured profile in
 * settings order. Keeping the order here means a retry can never jump ahead of
 * an assignment, and the extra candidates are labelled `"failover"` so
 * diagnostics distinguish a retry from a routing decision.
 */
export function resolveModelRouteCandidates(
  settings: ProfileSettings,
  overrides: Record<string, unknown> | undefined,
  modelId: string,
): ModelRoute[] {
  const primary = resolveModelRoute(settings, overrides, modelId);
  const candidates = [primary];
  for (const profileId of settings.profiles) {
    if (profileId !== primary.profileId) {
      candidates.push({ profileId, source: "failover" });
    }
  }
  return candidates;
}

/**
 * Per-model effort override for a request routed through `profileId`: the
 * composite entry wins over the plain one because it is the more specific
 * statement. `auto` (and any non-string value) means "no override".
 */
export function effortOverride(
  overrides: Record<string, unknown> | undefined,
  modelId: string,
  profileId?: string,
): string | undefined {
  if (!overrides) {
    return undefined;
  }
  const candidates = profileId
    ? [`${profileId}${PROFILE_MODEL_SEPARATOR}${modelId}`, modelId]
    : [modelId];
  for (const key of candidates) {
    const value = overrides[key];
    if (typeof value === "string" && value.trim() && value !== AUTO_EFFORT) {
      return value;
    }
  }
  return undefined;
}

/**
 * Assigns `modelId` to `profileId`. A model routes to exactly one profile, so
 * any previous assignment for the same model is replaced; `effort` defaults to
 * `auto`, which stores routing without changing the model's effort.
 */
export function assignModelToProfile(
  overrides: Record<string, unknown> | undefined,
  profileId: string,
  modelId: string,
  effort: string = AUTO_EFFORT,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...removeModelAssignment(overrides, modelId) };
  next[`${profileId}${PROFILE_MODEL_SEPARATOR}${modelId}`] = effort;
  return next;
}

/** Drops every `profile::model` entry of one profile, keeping plain overrides. */
export function removeProfileAssignments(
  overrides: Record<string, unknown> | undefined,
  profileId: string,
): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(overrides ?? {})) {
    const assignment = parseProfileModelAssignment(key);
    if (assignment?.profileId === profileId) {
      continue;
    }
    next[key] = value;
  }
  return next;
}

/** Drops every profile assignment of one model, keeping both plain overrides. */
export function removeModelAssignment(
  overrides: Record<string, unknown> | undefined,
  modelId: string,
): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(overrides ?? {})) {
    const assignment = parseProfileModelAssignment(key);
    if (assignment?.modelId === modelId) {
      continue;
    }
    next[key] = value;
  }
  return next;
}

/** Moves one profile's assignments to its new id, preserving entry order. */
export function renameProfileAssignments(
  overrides: Record<string, unknown> | undefined,
  from: string,
  to: string,
): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(overrides ?? {})) {
    const assignment = parseProfileModelAssignment(key);
    if (assignment?.profileId === from) {
      next[`${to}${PROFILE_MODEL_SEPARATOR}${assignment.modelId}`] = value;
      continue;
    }
    next[key] = value;
  }
  return next;
}

/** `activeProfile` after a delete: the current one if it survives, else the first. */
export function nextActiveProfile(profiles: readonly string[], current: string | undefined): string {
  const trimmed = typeof current === "string" ? current.trim() : "";
  if (trimmed && profiles.includes(trimmed)) {
    return trimmed;
  }
  return profiles[0] ?? "";
}

/**
 * Key presence per configured profile. Only the SecretStorage *names* are read,
 * so a diagnostics report can state presence without touching a secret value.
 */
export function profileKeyPresence(
  profiles: readonly string[],
  secretKeys: readonly string[],
): Array<{ profileId: string; hasKey: boolean }> {
  const stored = new Set(secretKeys);
  return profiles.map((profileId) => ({ profileId, hasKey: stored.has(profileSecretName(profileId)) }));
}

/**
 * Diagnostics-safe summary of a route. Only the profile id and how it was
 * chosen leave this function; the credential is never part of a route.
 */
export function describeRoute(route: ModelRoute): { profile: string; profileSource: ProfileRouteSource } {
  return { profile: route.profileId ?? "(shared key)", profileSource: route.source };
}
