import { PROVIDER_VENDOR } from "./constants";
import { SHARED_KEY_LABEL, type FailoverDiagnostics } from "./failover";
import { profileKeyPresence } from "./profiles";
import { sanitizeErrorBody } from "./providerErrors";
import { sanitizeUpstreamText } from "./text";
import { formatVendorConflictDiagnosticLine, type VendorConflict } from "./vendorConflict";

/**
 * Read-only troubleshooting helpers behind "Test Connection" and
 * "Show Diagnostics". Kept free of the `vscode` module so the report can be
 * unit-tested with a pre-selected host model list and a stubbed settings reader.
 *
 * Secrets never enter the report: keys are reported as a count, endpoint
 * credentials are redacted for display, and gateway error text is reduced to
 * structural identifiers by `sanitizeErrorBody`.
 */

/** How many reachable model IDs the Test Connection notification lists. */
export const MAX_REPORTED_MODEL_IDS = 20;

/** Placeholder used in place of secrets and credential-bearing URL values. */
const REDACTED = "******";

/** Upper bound for an endpoint shown in a notification or report line. */
const MAX_DISPLAY_URL_LENGTH = 500;

/** Bounds a structured gateway detail echoed into a message. */
const MAX_DISCOVERY_DETAIL_LENGTH = 200;

/**
 * Query and fragment parameter names whose values are credentials. Matching is
 * deliberately broad: false positives only hide an endpoint parameter, while a
 * miss would publish a secret.
 */
const CREDENTIAL_PARAM =
  /^(?:api[-_]?key|key|token|access[-_]?token|refresh[-_]?token|id[-_]?token|auth|authorization|bearer|password|passwd|secret|client[-_]?secret|signature|sig)$/i;

export interface HostModelLike {
  readonly id: string;
  readonly name?: string;
  readonly vendor?: string;
  readonly maxInputTokens?: number;
}

/** Structural subset of `vscode.lm` used here. */
export interface ChatModelSelector {
  selectChatModels(selector?: { vendor?: string }): Thenable<readonly HostModelLike[]>;
}

/** Structural subset of a `WorkspaceConfiguration` reader. */
export interface ConfigurationReader {
  get<T>(key: string, defaultValue: T): T | undefined;
}

/**
 * Model-discovery failure recorded at the HTTP boundary. The body never
 * travels past that boundary: only the HTTP status and a bounded, sanitized
 * structural summary are retained.
 */
export interface DiscoveryFailure {
  /** HTTP status, when the endpoint returned a response. */
  readonly status?: number;
  /** Sanitized gateway identifiers (error type/code/param), if any survived. */
  readonly detail?: string;
}

export interface DiagnosticsInput {
  readonly extensionVersion: string;
  readonly vscodeVersion: string;
  readonly baseUrl: string;
  readonly configuration: ConfigurationReader;
  /**
   * Host models selected immediately before this snapshot was taken. The
   * caller selects them first because selection can trigger provider discovery
   * and update the endpoint, stored key, cache, and discovery error.
   */
  readonly hostModels: readonly HostModelLike[];
  /** Names of the secrets this extension has stored; values are never read. */
  readonly secretKeys: readonly string[];
  /** Model IDs the extension knows locally: warm cache, else the curated catalog. */
  readonly trackedModels: readonly string[];
  /** Last model-discovery failure; raw text is still sanitized defensively. */
  readonly lastDiscoveryError?: string | DiscoveryFailure;
  /** Configured profile ids. Ids only: keys live in SecretStorage. */
  readonly profiles?: readonly string[];
  /** Profile used for models without a `profile::model` assignment. */
  readonly activeProfile?: string;
  /** `profile::model` routing entries, already reduced to profile/model pairs. */
  readonly profileAssignments?: ReadonlyArray<{ profileId: string; modelId: string }>;
  /**
   * Opt-in failover state: whether it is enabled and which keys are cooling
   * down, as profile ids and whole seconds. Never a key.
   */
  readonly failover?: FailoverDiagnostics;
  /** Override for tests; defaults to the current time. */
  readonly generatedAt?: string;
  readonly vendor?: string;
  /**
   * Another provider registering the same vendor, when the runtime check saw
   * one. Ids and counts only: the report line never names a key.
   */
  readonly vendorConflict?: VendorConflict;
}

/**
 * The full Markdown dump shown by "Show Diagnostics". Also written verbatim to
 * the output channel when the document cannot be opened. The caller selects the
 * host models first, so this only formats an already-taken snapshot.
 */
export function collectDiagnostics(input: DiagnosticsInput): string {
  const vendor = input.vendor ?? PROVIDER_VENDOR;
  const hostModels = input.hostModels;
  const discoveryMode = input.configuration.get<string>("discoveryMode", "curated") === "auto" ? "auto" : "curated";
  const includeUnknown = input.configuration.get<boolean>("includeUnknownModels", false) === true;
  const keyCount = input.secretKeys.length;

  const lines: string[] = [
    "# NaN Builders diagnostics",
    "",
    `- Generated: ${input.generatedAt ?? new Date().toISOString()}`,
    `- VS Code: ${input.vscodeVersion}`,
    `- Extension: ${input.extensionVersion}`,
    `- Base URL: ${formatEndpointForDisplay(input.baseUrl)}`,
    `- Discovery mode: ${discoveryMode}`,
    `- Include unknown models: ${includeUnknown ? "yes" : "no"}`,
    `- API key configured: ${keyCount > 0 ? "yes" : "no"}`,
    `- Configured keys/profiles: ${keyCount} (count only; key values are never read)`,
    `- Failover on throttle: ${input.failover?.enabled ? "on (one hop per request)" : "off (fixed routing)"}`,
    "",
    "## Models exposed by this VS Code host",
    "",
  ];

  if (hostModels.length > 0) {
    lines.push(
      `\`vscode.lm.selectChatModels\` returned ${hostModels.length} model(s) for vendor \`${vendor}\`.`,
      "",
      "| Model id | maxInputTokens |",
      "| --- | --- |",
      ...hostModels.map((model) => `| \`${model.id}\` | ${formatTokenBudget(model.maxInputTokens)} |`),
    );
  } else {
    lines.push(
      `\`vscode.lm.selectChatModels\` returned no model for vendor \`${vendor}\`. ` +
        "Reload the window, then run **NaN Builders: Refresh Models**.",
    );
  }

  if (input.vendorConflict) {
    lines.push("", "## Vendor conflict", "", formatVendorConflictDiagnosticLine(input.vendorConflict));
  }

  lines.push(
    "",
    "## Profiles",
    "",
    ...describeProfiles(input),
    "",
    "## Locally tracked models",
    "",
    `- Count: ${input.trackedModels.length}`,
    ...input.trackedModels.map((id) => `- \`${id}\``),
    "",
    "## Last model discovery",
    "",
    describeDiscovery(input.lastDiscoveryError),
    "",
    "## Secrets",
    "",
    "- No API key, token, or Authorization header is included in this report.",
    "- Keys are reported as a count only; their values are never read.",
    "",
  );

  return lines.join("\n");
}

/**
 * Profiles section of the report. Only ids, routing, and key *presence* are
 * printed; the secret values are never read here, so a report can be shared.
 */
function describeProfiles(input: DiagnosticsInput): string[] {
  const profiles = input.profiles ?? [];
  if (profiles.length === 0) {
    return [
      "- No profiles configured: every model uses the shared `nanBuilders.apiKey` key.",
      "- Add profiles in **NaN Builders: Manage Provider** → **Profiles**.",
      ...describeCooldowns(input),
    ];
  }
  const activeProfile = input.activeProfile && input.activeProfile.trim() ? input.activeProfile.trim() : profiles[0];
  const presence = profileKeyPresence(profiles, input.secretKeys);
  const assignments = input.profileAssignments ?? [];
  return [
    `- Active profile: \`${activeProfile}\``,
    `- Configured profiles: ${presence.length}`,
    ...presence.map(
      ({ profileId, hasKey }) =>
        `- \`${profileId}\`${profileId === activeProfile ? " (active)" : ""}: key ${hasKey ? "configured" : "missing (requests fail and name the profile)"}`,
    ),
    ...(assignments.length > 0
      ? [
          "",
          "Model routing (`nanBuilders.reasoningEffortByModel`):",
          "",
          ...assignments.map(({ profileId, modelId }) => `- \`${modelId}\` → profile \`${profileId}\``),
        ]
      : ["", "- No `profile::model` assignments: every model uses the active profile."]),
    ...describeCooldowns(input),
  ];
}

/**
 * Cooldown state left by the opt-in failover: profile ids and whole seconds
 * only, so the report stays safe to share and never names a key.
 */
function describeCooldowns(input: DiagnosticsInput): string[] {
  const cooling = input.failover?.cooling ?? [];
  if (cooling.length === 0 || !input.failover?.enabled) {
    return [];
  }
  return [
    "",
    "Cooldown after a rate limit:",
    "",
    ...cooling.map(
      ({ profileId, remainingSeconds }) =>
        `- \`${profileId ?? SHARED_KEY_LABEL}\`: cooling down, ${remainingSeconds}s left`,
    ),
  ];
}

/** "OK — N models reachable (ids)". */
export function formatConnectionOk(modelIds: readonly string[]): string {
  const shown = modelIds.slice(0, MAX_REPORTED_MODEL_IDS);
  const rest = modelIds.length - shown.length;
  const list = shown.length > 0 ? shown.join(", ") : "none";
  return `OK — ${modelIds.length} model${modelIds.length === 1 ? "" : "s"} reachable (${list}${rest > 0 ? `, +${rest} more` : ""})`;
}

/** Actionable warning for a key that sees no models. */
export function formatConnectionWarning(
  baseUrl: string,
  failure?: string | DiscoveryFailure,
): string {
  const detail = sanitizedDiscoveryDetail(failure);
  return [
    `NaN Builders found no models for the configured API key at ${formatEndpointForDisplay(baseUrl)}.`,
    detail,
    "Check that the key can call GET /models (run 'NaN Builders: Manage Provider' → 'Validate API key and refresh models'), then run 'NaN Builders: Refresh Models'.",
  ]
    .filter((part): part is string => Boolean(part))
    .join(" ");
}

/**
 * Display-only endpoint formatter for the report and the notifications. Userinfo
 * is dropped and credential-bearing query/fragment values are replaced. This
 * must never be applied to request URLs: discovery and chat must keep using the
 * configured value unchanged.
 */
export function formatEndpointForDisplay(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    // Never echo a malformed value: it may itself contain credentials.
    return "(unparseable base URL)";
  }

  url.username = "";
  url.password = "";
  url.search = redactCredentialParams(url.search);
  if (url.hash) {
    url.hash = redactCredentialParams(url.hash.slice(1));
  }

  // Catches a key pasted into the path and any control characters.
  return sanitizeUpstreamText(url.toString(), MAX_DISPLAY_URL_LENGTH);
}

function redactCredentialParams(rawParams: string): string {
  if (!rawParams) {
    return "";
  }
  if (!rawParams.includes("=")) {
    // An opaque fragment cannot be classified, so it is withheld entirely.
    return REDACTED;
  }
  const params = new URLSearchParams(rawParams);
  for (const name of [...params.keys()]) {
    if (CREDENTIAL_PARAM.test(name)) {
      params.set(name, REDACTED);
    }
  }
  return params.toString();
}

/**
 * Gateway text is never shown raw. Only the structural identifiers kept by
 * `sanitizeErrorBody` (error type/code/param) survive; free-form messages,
 * which may echo a key or prompt, are dropped. The HTTP status is structural
 * data, so it is still reported when the body yields nothing safe. Raw strings
 * are accepted for defensive re-sanitization; the HTTP boundary already stores
 * structured failures.
 */
export function sanitizedDiscoveryDetail(failure: string | DiscoveryFailure | undefined): string | undefined {
  if (!failure) {
    return undefined;
  }
  if (typeof failure === "string") {
    const status = /HTTP\s+(\d{3})\b/.exec(failure)?.[1];
    return joinDiscoveryDetail(
      status === undefined ? undefined : Number(status),
      sanitizeErrorBody(failure) || undefined,
    );
  }
  return joinDiscoveryDetail(failure.status, failure.detail);
}

function joinDiscoveryDetail(status: number | undefined, detail: string | undefined): string {
  // The HTTP boundary already sanitized `detail`; re-sanitizing keeps a caller
  // that constructs a failure by hand from leaking secrets.
  const safeDetail = detail ? sanitizeUpstreamText(detail, MAX_DISCOVERY_DETAIL_LENGTH) : "";
  return [
    status === undefined ? undefined : `The endpoint answered HTTP ${status}.`,
    safeDetail
      ? `Gateway said: ${safeDetail}.`
      : "The gateway error detail was withheld because it could not be reduced to safe identifiers.",
  ]
    .filter((part): part is string => Boolean(part))
    .join(" ");
}

export function describeDiscovery(failure: string | DiscoveryFailure | undefined): string {
  const detail = sanitizedDiscoveryDetail(failure);
  return detail ? `- Last discovery error: ${detail}` : "- Last discovery error: none recorded.";
}

export async function selectHostModels(lm: ChatModelSelector, vendor: string): Promise<HostModelLike[]> {
  const models = await lm.selectChatModels({ vendor });
  return models
    .filter((model) => !model.vendor || model.vendor === vendor)
    .map((model) => ({ id: model.id, name: model.name, vendor: model.vendor, maxInputTokens: model.maxInputTokens }));
}

function formatTokenBudget(maxInputTokens: number | undefined): string {
  return typeof maxInputTokens === "number" && Number.isFinite(maxInputTokens)
    ? Math.max(0, Math.round(maxInputTokens)).toLocaleString("en-US")
    : "unknown";
}
