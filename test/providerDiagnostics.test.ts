import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_REPORTED_MODEL_IDS,
  collectDiagnostics,
  describeDiscovery,
  formatConnectionOk,
  formatConnectionWarning,
  formatEndpointForDisplay,
  selectHostModels,
  type ChatModelSelector,
} from "../src/providerDiagnostics";
import { profileSecretName } from "../src/profiles";
import { detectVendorConflict } from "../src/vendorConflict";

const SENTINEL_KEY = "sk-live-SENTINEL-8f4c2b";

function stubLm(models: ReadonlyArray<{ id: string; name?: string; vendor?: string; maxInputTokens?: number }>): ChatModelSelector {
  return {
    // Mirror VS Code: the selector narrows the list, the result is not pre-filtered.
    selectChatModels: async () => models,
  };
}

/** Host models as the extension passes them: selected before the report snapshot. */
function hostModels(
  models: ReadonlyArray<{ id: string; name?: string; vendor?: string; maxInputTokens?: number }>,
) {
  return selectHostModels(stubLm(models), "nan-builders");
}

function stubSettings(values: Record<string, unknown> = {}) {
  return {
    get<T>(key: string, defaultValue: T): T {
      return (values[key] as T | undefined) ?? defaultValue;
    },
  };
}

test("diagnostics report includes versions, endpoint, host models, key count, and tracked models", async () => {
  const markdown = collectDiagnostics({
    generatedAt: "2026-11-16T22:00:00.000Z",
    extensionVersion: "1.5.1",
    vscodeVersion: "1.104.0",
    baseUrl: "https://api.nan.builders/v1",
    configuration: stubSettings({ discoveryMode: "auto", includeUnknownModels: true }),
    hostModels: await hostModels([
      { id: "glm5.3-flash", vendor: "nan-builders", maxInputTokens: 126_976 },
      { id: "gemma4", vendor: "nan-builders", maxInputTokens: 32_000 },
      { id: "gpt-4o", vendor: "copilot", maxInputTokens: 128_000 },
      { id: "no-budget", vendor: "nan-builders" },
    ]),
    secretKeys: ["nanBuilders.apiKey"],
    trackedModels: ["glm5.3-flash", "gemma4"],
  });

  assert.match(markdown, /^# NaN Builders diagnostics$/m);
  assert.match(markdown, /^- Generated: 2026-11-16T22:00:00\.000Z$/m);
  assert.match(markdown, /^- VS Code: 1\.104\.0$/m);
  assert.match(markdown, /^- Extension: 1\.5\.1$/m);
  assert.match(markdown, /^- Base URL: https:\/\/api\.nan\.builders\/v1$/m);
  assert.match(markdown, /^- Discovery mode: auto$/m);
  assert.match(markdown, /^- Include unknown models: yes$/m);
  assert.match(markdown, /^- API key configured: yes$/m);
  assert.match(markdown, /^- Configured keys\/profiles: 1 \(count only; key values are never read\)$/m);
  assert.match(markdown, /returned 3 model\(s\) for vendor `nan-builders`/);
  assert.match(markdown, /\| `glm5\.3-flash` \| 126,976 \|/);
  assert.match(markdown, /\| `no-budget` \| unknown \|/);
  assert.doesNotMatch(markdown, /gpt-4o/, "models from other vendors are excluded");
  assert.match(markdown, /## Locally tracked models[\s\S]*- Count: 2[\s\S]*- `glm5\.3-flash`/);
});

test("diagnostics report never contains a key value, even when the gateway echoes it", async () => {
  const markdown = collectDiagnostics({
    extensionVersion: "1.5.1",
    vscodeVersion: "1.104.0",
    baseUrl: "https://api.nan.builders/v1",
    configuration: stubSettings(),
    hostModels: await hostModels([{ id: "glm5.3-flash", vendor: "nan-builders", maxInputTokens: 1_000 }]),
    secretKeys: ["nanBuilders.apiKey"],
    trackedModels: ["glm5.3-flash"],
    lastDiscoveryError: JSON.stringify({
      error: {
        type: "invalid_api_key",
        code: "bad_key",
        message: `Incorrect API key provided: ${SENTINEL_KEY}. Authorization: Bearer ${SENTINEL_KEY}`,
      },
    }),
  });

  assert.equal(markdown.includes(SENTINEL_KEY), false, "the API key sentinel must never appear in the report");
  assert.doesNotMatch(markdown, /Bearer/i);
  assert.match(markdown, /- Last discovery error: Gateway said: invalid_api_key bad_key\./);
  assert.match(markdown, /No API key, token, or Authorization header is included in this report\./);
});

test("diagnostics report explains an empty host model list", async () => {
  const markdown = collectDiagnostics({
    extensionVersion: "1.5.1",
    vscodeVersion: "1.104.0",
    baseUrl: "https://api.nan.builders/v1",
    configuration: stubSettings(),
    hostModels: await hostModels([]),
    secretKeys: [],
    trackedModels: [],
  });

  assert.match(markdown, /returned no model for vendor `nan-builders`/);
  assert.match(markdown, /^- API key configured: no$/m);
  assert.match(markdown, /^- Configured keys\/profiles: 0/m);
  assert.match(markdown, /- Count: 0/);
  assert.match(markdown, /- Last discovery error: none recorded\./);
});

test("diagnostics report names a vendor conflict with counts only and no secrets", async () => {
  const vendorConflict = detectVendorConflict(
    ["glm5.3-flash", "gemma4", "foreign-model", "gemma4"],
    ["glm5.3-flash", "gemma4"],
  );
  assert.ok(vendorConflict);
  const markdown = collectDiagnostics({
    extensionVersion: "1.5.1",
    vscodeVersion: "1.104.0",
    baseUrl: "https://api.nan.builders/v1",
    configuration: stubSettings(),
    hostModels: await hostModels([
      { id: "glm5.3-flash", vendor: "nan-builders" },
      { id: "gemma4", vendor: "nan-builders" },
      { id: "foreign-model", vendor: "nan-builders" },
      { id: "gemma4", vendor: "nan-builders" },
    ]),
    secretKeys: ["nanBuilders.apiKey"],
    trackedModels: ["glm5.3-flash", "gemma4"],
    vendorConflict,
  });

  assert.match(markdown, /## Vendor conflict/);
  assert.match(markdown, /`provider\.vendorConflict`: vendor `nan-builders`; 2 model\(s\) observed from another provider/);
  assert.match(markdown, /this extension is active \(2 model\(s\) published\)/);
  assert.match(markdown, /Duplicate ids: `gemma4`\./);
  assert.equal(markdown.includes(SENTINEL_KEY), false);
});

test("diagnostics report omits the vendor-conflict section when nothing conflicted", async () => {
  const markdown = collectDiagnostics({
    extensionVersion: "1.5.1",
    vscodeVersion: "1.104.0",
    baseUrl: "https://api.nan.builders/v1",
    configuration: stubSettings(),
    hostModels: await hostModels([{ id: "glm5.3-flash", vendor: "nan-builders" }]),
    secretKeys: [],
    trackedModels: ["glm5.3-flash"],
  });
  assert.doesNotMatch(markdown, /provider\.vendorConflict/);
});

test("diagnostics report shows the failover setting and any key cooldown with ids only", async () => {
  const off = collectDiagnostics({
    extensionVersion: "1.5.1",
    vscodeVersion: "1.104.0",
    baseUrl: "https://api.nan.builders/v1",
    configuration: stubSettings(),
    hostModels: await hostModels([]),
    secretKeys: [],
    trackedModels: [],
  });
  assert.match(off, /^- Failover on throttle: off \(fixed routing\)$/m);
  assert.doesNotMatch(off, /Cooldown after a rate limit/);

  const on = collectDiagnostics({
    extensionVersion: "1.5.1",
    vscodeVersion: "1.104.0",
    baseUrl: "https://api.nan.builders/v1",
    configuration: stubSettings(),
    hostModels: await hostModels([]),
    secretKeys: [profileSecretName("work"), profileSecretName("personal")],
    profiles: ["personal", "work"],
    activeProfile: "personal",
    failover: {
      enabled: true,
      cooling: [
        { profileId: "work", remainingSeconds: 42 },
        { profileId: undefined, remainingSeconds: 7 },
      ],
    },
    trackedModels: [],
  });

  assert.match(on, /^- Failover on throttle: on \(one hop per request\)$/m);
  assert.match(on, /Cooldown after a rate limit:/);
  assert.match(on, /- `work`: cooling down, 42s left/);
  assert.match(on, /- `\(shared key\)`: cooling down, 7s left/);
  // A report is shareable: ids and seconds, never a key or its secret name.
  assert.equal(on.includes(SENTINEL_KEY), false);
  assert.doesNotMatch(on, new RegExp(profileSecretName("work")));
});

test("diagnostics report hides cooldowns while the failover is off", async () => {
  const markdown = collectDiagnostics({
    extensionVersion: "1.5.1",
    vscodeVersion: "1.104.0",
    baseUrl: "https://api.nan.builders/v1",
    configuration: stubSettings(),
    hostModels: await hostModels([]),
    secretKeys: [],
    profiles: ["personal", "work"],
    activeProfile: "personal",
    // A window that was turned off after a key was benched must not leak state.
    failover: { enabled: false, cooling: [{ profileId: "work", remainingSeconds: 42 }] },
    trackedModels: [],
  });

  assert.match(markdown, /^- Failover on throttle: off \(fixed routing\)$/m);
  assert.doesNotMatch(markdown, /cooling down/);
});

test("selectHostModels maps the host list to id and maxInputTokens", async () => {
  const models = await selectHostModels(
    stubLm([
      { id: "glm5.3-flash", name: "GLM 5.3 Flash", vendor: "nan-builders", maxInputTokens: 126_976 },
      { id: "gpt-4o", vendor: "copilot", maxInputTokens: 128_000 },
    ]),
    "nan-builders",
  );

  assert.deepEqual(models.map((model) => model.id), ["glm5.3-flash"]);
  assert.equal(models[0]!.maxInputTokens, 126_976);
});

test("connection success lists the model count and ids", () => {
  assert.equal(formatConnectionOk(["glm5.3-flash", "gemma4"]), "OK — 2 models reachable (glm5.3-flash, gemma4)");
  assert.equal(formatConnectionOk(["glm5.3-flash"]), "OK — 1 model reachable (glm5.3-flash)");

  const many = Array.from({ length: MAX_REPORTED_MODEL_IDS + 5 }, (_, index) => `model-${index}`);
  const message = formatConnectionOk(many);
  assert.match(message, new RegExp(`^OK — ${MAX_REPORTED_MODEL_IDS + 5} models reachable \\(`));
  assert.match(message, /, \+5 more\)$/);
});

test("connection warning is actionable and sanitizes gateway error text", () => {
  const warning = formatConnectionWarning(
    "https://api.nan.builders/v1",
    JSON.stringify({
      error: {
        type: "invalid_api_key",
        code: "bad_key",
        message: `Incorrect API key provided: ${SENTINEL_KEY}`,
      },
    }),
  );

  assert.equal(warning.includes(SENTINEL_KEY), false, "the API key sentinel must never appear in the warning");
  assert.equal(warning.includes("Incorrect API key provided"), false, "free-form gateway text is dropped");
  assert.match(warning, /NaN Builders found no models for the configured API key at https:\/\/api\.nan\.builders\/v1\./);
  assert.match(warning, /Gateway said: invalid_api_key bad_key\./);
  assert.match(warning, /NaN Builders: Manage Provider/);
  assert.match(warning, /NaN Builders: Refresh Models/);
});

test("connection warning reports the HTTP status and withholds unsanitizable bodies", () => {
  const warning = formatConnectionWarning(
    "https://api.nan.builders/v1",
    `Unable to discover NaN Builders models: HTTP 503 ${SENTINEL_KEY}`,
  );

  assert.equal(warning.includes(SENTINEL_KEY), false);
  assert.match(warning, /The endpoint answered HTTP 503\./);
  assert.match(warning, /error detail was withheld/);
  assert.match(describeDiscovery(`HTTP 503 ${SENTINEL_KEY}`), /HTTP 503/);
  assert.equal(describeDiscovery(`HTTP 503 ${SENTINEL_KEY}`).includes(SENTINEL_KEY), false);
});

test("formatEndpointForDisplay drops userinfo and redacts credential params only", () => {
  const display = formatEndpointForDisplay(
    `https://user:${SENTINEL_KEY}@api.nan.builders/v1?api_key=${SENTINEL_KEY}&region=eu#token=${SENTINEL_KEY}`,
  );

  assert.equal(display.includes(SENTINEL_KEY), false, "credentials must never reach the display form");
  assert.equal(display.includes("user"), false, "userinfo must be removed");
  assert.match(
    display,
    /^https:\/\/api\.nan\.builders\/v1\?api_key=\*{6}&region=eu#token=\*{6}$/,
    "non-credential parameters stay readable",
  );
});

test("formatEndpointForDisplay redacts key and token parameter aliases", () => {
  const display = formatEndpointForDisplay("https://api.nan.builders/v1?key=abc&token=def&access_token=ghi&model=gpt");

  assert.match(display, /^https:\/\/api\.nan\.builders\/v1\?key=\*{6}&token=\*{6}&access_token=\*{6}&model=gpt$/);
});

test("formatEndpointForDisplay never echoes a malformed URL", () => {
  const display = formatEndpointForDisplay(`api.nan.builders/v1?api_key=${SENTINEL_KEY}`);

  assert.equal(display.includes(SENTINEL_KEY), false);
  assert.match(display, /unparseable base URL/);
});

test("diagnostics report and connection warning redact endpoint credentials", async () => {
  const credentialUrl = `https://user:${SENTINEL_KEY}@api.nan.builders/v1?api_key=${SENTINEL_KEY}`;
  const markdown = collectDiagnostics({
    extensionVersion: "1.5.1",
    vscodeVersion: "1.104.0",
    baseUrl: credentialUrl,
    configuration: stubSettings(),
    hostModels: await hostModels([{ id: "glm5.3-flash", vendor: "nan-builders", maxInputTokens: 1_000 }]),
    secretKeys: ["nanBuilders.apiKey"],
    trackedModels: ["glm5.3-flash"],
  });

  assert.equal(markdown.includes(SENTINEL_KEY), false, "the report must never contain the URL credentials");
  assert.match(markdown, /^- Base URL: https:\/\/api\.nan\.builders\/v1\?api_key=\*{6}$/m);

  const warning = formatConnectionWarning(credentialUrl);
  assert.equal(warning.includes(SENTINEL_KEY), false, "the warning must never contain the URL credentials");
  assert.match(warning, /at https:\/\/api\.nan\.builders\/v1\?api_key=\*{6}\./);
});

test("structured discovery failures keep the HTTP status and sanitized detail", () => {
  const warning = formatConnectionWarning("https://api.nan.builders/v1", {
    status: 401,
    detail: "invalid_api_key bad_key",
  });

  assert.match(warning, /The endpoint answered HTTP 401\./);
  assert.match(warning, /Gateway said: invalid_api_key bad_key\./);

  const noDetail = describeDiscovery({ status: 503 });
  assert.match(noDetail, /The endpoint answered HTTP 503\./);
  assert.match(noDetail, /error detail was withheld/);
  assert.match(describeDiscovery({ detail: `bad_key ${SENTINEL_KEY}` }), /Gateway said: bad_key \*{6}\./);
  assert.equal(describeDiscovery({ detail: `bad_key ${SENTINEL_KEY}` }).includes(SENTINEL_KEY), false);
});
