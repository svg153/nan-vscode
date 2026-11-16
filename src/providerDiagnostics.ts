import { PROVIDER_VENDOR } from "./constants";
import { sanitizeErrorBody } from "./openai/request";

/**
 * Read-only troubleshooting helpers behind "Test Connection" and
 * "Show Diagnostics". Kept free of the `vscode` module so the report can be
 * unit-tested with a stubbed host model selector and settings reader.
 *
 * Secrets never enter the report: keys are reported as a count, and gateway
 * error text is reduced to structural identifiers by `sanitizeErrorBody`.
 */

/** How many reachable model IDs the Test Connection notification lists. */
export const MAX_REPORTED_MODEL_IDS = 20;

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

export interface DiagnosticsInput {
  readonly extensionVersion: string;
  readonly vscodeVersion: string;
  readonly baseUrl: string;
  readonly configuration: ConfigurationReader;
  readonly lm: ChatModelSelector;
  /** Names of the secrets this extension has stored; values are never read. */
  readonly secretKeys: readonly string[];
  /** Model IDs the extension knows locally: warm cache, else the curated catalog. */
  readonly trackedModels: readonly string[];
  /** Last raw discovery error message, sanitized before it reaches the report. */
  readonly lastDiscoveryError?: string;
  /** Override for tests; defaults to the current time. */
  readonly generatedAt?: string;
  readonly vendor?: string;
}

/**
 * The full Markdown dump shown by "Show Diagnostics". Also written verbatim to
 * the output channel when the document cannot be opened.
 */
export async function collectDiagnostics(input: DiagnosticsInput): Promise<string> {
  const vendor = input.vendor ?? PROVIDER_VENDOR;
  const hostModels = await selectHostModels(input.lm, vendor);
  const discoveryMode = input.configuration.get<string>("discoveryMode", "curated") === "auto" ? "auto" : "curated";
  const includeUnknown = input.configuration.get<boolean>("includeUnknownModels", false) === true;
  const keyCount = input.secretKeys.length;

  const lines: string[] = [
    "# NaN Builders diagnostics",
    "",
    `- Generated: ${input.generatedAt ?? new Date().toISOString()}`,
    `- VS Code: ${input.vscodeVersion}`,
    `- Extension: ${input.extensionVersion}`,
    `- Base URL: ${input.baseUrl}`,
    `- Discovery mode: ${discoveryMode}`,
    `- Include unknown models: ${includeUnknown ? "yes" : "no"}`,
    `- API key configured: ${keyCount > 0 ? "yes" : "no"}`,
    `- Configured keys/profiles: ${keyCount} (count only; key values are never read)`,
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

  lines.push(
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

/** "OK — N models reachable (ids)". */
export function formatConnectionOk(modelIds: readonly string[]): string {
  const shown = modelIds.slice(0, MAX_REPORTED_MODEL_IDS);
  const rest = modelIds.length - shown.length;
  const list = shown.length > 0 ? shown.join(", ") : "none";
  return `OK — ${modelIds.length} model${modelIds.length === 1 ? "" : "s"} reachable (${list}${rest > 0 ? `, +${rest} more` : ""})`;
}

/** Actionable warning for a key that sees no models. */
export function formatConnectionWarning(baseUrl: string, errorText?: string): string {
  const detail = sanitizedDiscoveryDetail(errorText);
  return [
    `NaN Builders found no models for the configured API key at ${baseUrl}.`,
    detail,
    "Check that the key can call GET /models (run 'NaN Builders: Manage Provider' → 'Validate API key and refresh models'), then run 'NaN Builders: Refresh Models'.",
  ]
    .filter((part): part is string => Boolean(part))
    .join(" ");
}

/**
 * Gateway text is never shown raw. Only the structural identifiers kept by
 * `sanitizeErrorBody` (error type/code/param) survive; free-form messages,
 * which may echo a key or prompt, are dropped. The HTTP status is structural
 * data, so it is still reported when the body yields nothing safe.
 */
export function sanitizedDiscoveryDetail(errorText: string | undefined): string | undefined {
  if (!errorText) {
    return undefined;
  }
  const status = /HTTP\s+(\d{3})\b/.exec(errorText)?.[1];
  const sanitized = sanitizeErrorBody(errorText);
  return [
    status ? `The endpoint answered HTTP ${status}.` : undefined,
    sanitized
      ? `Gateway said: ${sanitized}.`
      : "The gateway error detail was withheld because it could not be reduced to safe identifiers.",
  ]
    .filter((part): part is string => Boolean(part))
    .join(" ");
}

export function describeDiscovery(errorText: string | undefined): string {
  const detail = sanitizedDiscoveryDetail(errorText);
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
